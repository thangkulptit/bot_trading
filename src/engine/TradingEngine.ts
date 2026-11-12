import type { AIAnalyst } from '../ai/AIAnalyst';
import type { ContextBuilder } from '../ai/ContextBuilder';
import type { Broker } from '../broker/Broker';
import type { Config } from '../config';
import type { OrderRepository } from '../db/OrderRepository';
import { logger } from '../logger';
import type { MarketData } from '../market/MarketData';
import type { NewsService } from '../news/NewsService';
import type { RiskManager } from '../risk/RiskManager';
import type { Bias, Check, ScalpStrategy, StrategyResult } from '../strategy/ScalpStrategy';
import type { AccountInfo, AIDecision, MarketSnapshot, Position, Quote, SignalCandidate, Side } from '../types';
import { errMsg, round } from '../utils';

export interface EngineDeps {
  cfg: Config;
  broker: Broker;
  md: MarketData;
  news: NewsService;
  analyst: AIAnalyst;
  risk: RiskManager;
  orders: OrderRepository;
  strategy: ScalpStrategy;
  context: ContextBuilder;
}

export interface EngineStatus {
  running: boolean;
  lastRunAt: number | null;
  lastAction: string;
  bias: Bias | null;
  blockedReasons: string[];
  strategyNotes: string[];
  checklist: Check[];
  softScore: StrategyResult['softScore'] | null;
  lastSignal: SignalCandidate | null;
  lastDecision: (AIDecision & { time: number }) | null;
  lastError: string | null;
}

interface Gathered {
  account: AccountInfo;
  positions: Position[];
  snap: MarketSnapshot;
  strategy: StrategyResult;
  blocks: string[];
}

interface PlannedOrder {
  side: Side;
  /** Giá vào lệnh lúc phân tích — dùng phát hiện giá trượt trước khi gửi lệnh. */
  refEntry: number;
  stopLoss: number;
  takeProfit: number;
  source: 'rules' | 'rules+ai' | 'ai';
  reasoning?: string;
  confidence?: number;
}

export class TradingEngine {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastEvaluatedCandle = 0;
  private lastAiCallAt = 0;
  lastAtrM5 = NaN;

  readonly status: EngineStatus = {
    running: false,
    lastRunAt: null,
    lastAction: 'idle',
    bias: null,
    blockedReasons: [],
    strategyNotes: [],
    checklist: [],
    softScore: null,
    lastSignal: null,
    lastDecision: null,
    lastError: null,
  };

  constructor(private d: EngineDeps) {}

  start(): void {
    if (this.status.running) return;
    this.status.running = true;
    logger.info(`Engine START — mode=${this.d.cfg.MODE}, AI=${this.d.cfg.AI_MODE}, broker=${this.d.broker.name}`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.d.cfg.LOOP_INTERVAL_SEC * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.status.running) logger.info('Engine STOP — không mở lệnh mới (monitor vẫn quản lý lệnh đang mở)');
    this.status.running = false;
  }

  private async loadSnapshot(): Promise<MarketSnapshot> {
    const { md } = this.d;
    const [quote, m1, m5, m15, h1, h4] = await Promise.all([
      md.getQuote(),
      md.getCandles('1m', 120),
      md.getCandles('5m', 150),
      md.getCandles('15m', 260),
      md.getCandles('1h', 300),
      md.getCandles('4h', 120),
    ]);
    return { quote, m1, m5, m15, h1, h4 };
  }

  private sessionBlock(now: number): string | null {
    const { cfg } = this.d;
    const t = new Date(now);
    const hour = t.getUTCHours() + t.getUTCMinutes() / 60;
    const weekday = t.getUTCDay();
    if (weekday === 0 || weekday === 6) return 'Cuối tuần — thị trường đóng';
    if (weekday === 5 && hour >= cfg.FRIDAY_CUTOFF_UTC) return 'Chiều thứ Sáu — không mở lệnh mới';
    if (hour < cfg.SESSION_START_UTC || hour >= cfg.SESSION_END_UTC) {
      return `Ngoài phiên giao dịch (${cfg.SESSION_START_UTC}:00–${cfg.SESSION_END_UTC}:00 UTC)`;
    }
    return null;
  }

  /** Các chốt chặn không phụ thuộc tín hiệu: phiên, tin tức, giới hạn rủi ro. */
  private gateBlocks(account: AccountInfo, positions: Position[], quote: Quote, now: number): string[] {
    const blocks: string[] = [];
    const session = this.sessionBlock(now);
    if (session) blocks.push(session);
    const newsStatus = this.d.news.getBlockStatus(now);
    if (newsStatus.blocked && newsStatus.reason) blocks.push(newsStatus.reason);
    blocks.push(...this.d.risk.canOpen(account, positions, quote, now));
    return blocks;
  }

  private async gather(now: number): Promise<Gathered> {
    const { broker, risk, strategy } = this.d;
    const [account, positions, snap] = await Promise.all([
      broker.getAccount(),
      broker.getPositions(),
      this.loadSnapshot(),
    ]);
    await risk.refreshDay(account, now);
    const result = strategy.evaluate(snap, now);
    if (Number.isFinite(result.atrM5)) this.lastAtrM5 = result.atrM5;
    return { account, positions, snap, strategy: result, blocks: this.gateBlocks(account, positions, snap.quote, now) };
  }

  private async buildContext(now: number, g: Gathered, candidate: SignalCandidate | null): Promise<string> {
    const { context, risk, news, analyst, orders } = this.d;
    const [recentTrades, recentDecisions] = await Promise.all([orders.recentClosed(5), orders.recentDecisions(3)]);
    return context.build({
      now,
      snap: g.snap,
      account: g.account,
      positions: g.positions,
      risk: risk.summary(g.account),
      strategy: g.strategy,
      candidate,
      news: { upcoming: news.upcoming(now), recent: news.recent(now), briefing: analyst.briefingSummary() },
      recentTrades,
      recentDecisions,
    });
  }

  private async askAI(now: number, g: Gathered, candidate: SignalCandidate | null): Promise<AIDecision> {
    this.lastAiCallAt = now;
    const decision = await this.d.analyst.decide(await this.buildContext(now, g, candidate));
    this.status.lastDecision = { ...decision, time: now };
    logger.info(`AI: ${decision.action} (${round(decision.confidence * 100)}%) — ${decision.reasoning}`);
    return decision;
  }

  /** Dùng SL/TP do AI tinh chỉnh nếu hợp lệ, ngược lại giữ mức của chiến lược. */
  private mergeLevels(candidate: SignalCandidate, decision: AIDecision): PlannedOrder {
    const base: PlannedOrder = {
      side: candidate.side,
      refEntry: candidate.entry,
      stopLoss: candidate.stopLoss,
      takeProfit: candidate.takeProfit,
      source: 'rules+ai',
      reasoning: decision.reasoning,
      confidence: decision.confidence,
    };
    const sl = decision.stopLoss ?? candidate.stopLoss;
    const tp = decision.takeProfit ?? candidate.takeProfit;
    if (this.d.risk.validateOrder(candidate.side, candidate.entry, sl, tp) === null) {
      base.stopLoss = sl;
      base.takeProfit = tp;
    }
    return base;
  }

  async tick(): Promise<void> {
    if (this.busy || !this.status.running) return;
    this.busy = true;
    const now = Date.now();
    const { cfg, analyst, orders } = this.d;
    try {
      if (cfg.AI_MODE !== 'off') void analyst.getBriefing();

      const g = await this.gather(now);
      Object.assign(this.status, {
        lastRunAt: now,
        bias: g.strategy.bias,
        blockedReasons: g.blocks,
        strategyNotes: g.strategy.notes,
        checklist: g.strategy.checks,
        softScore: g.strategy.softScore,
        lastError: null,
      });
      if (g.blocks.length) {
        this.status.lastAction = 'blocked';
        logger.debug('Không vào lệnh', g.blocks);
        return;
      }

      const candidate = g.strategy.candidate;
      if (candidate) this.status.lastSignal = candidate;
      const freshSignal = candidate !== null && candidate.candleTime !== this.lastEvaluatedCandle;
      if (candidate) this.lastEvaluatedCandle = candidate.candleTime;

      let order: PlannedOrder | null = null;
      let decision: AIDecision | null = null;
      let note = candidate ? 'Tín hiệu bị AI từ chối' : 'Chưa đạt checklist vào lệnh';

      if (cfg.AI_MODE === 'off') {
        if (candidate && freshSignal) order = { ...candidate, refEntry: candidate.entry, source: 'rules' };
      } else if (cfg.AI_MODE === 'confirm') {
        if (candidate && freshSignal) {
          decision = await this.askAI(now, g, candidate);
          if (decision.action === candidate.side && decision.confidence >= cfg.AI_MIN_CONFIDENCE) {
            order = this.mergeLevels(candidate, decision);
          }
        }
      } else {
        // autonomous: AI tự chọn điểm vào nhưng chỉ khi mọi điều kiện thị trường (env) bắt buộc đã đạt
        const envOk = g.strategy.checks.some((c) => c.group === 'env') &&
          g.strategy.checks.filter((c) => c.group === 'env' && c.hard).every((c) => c.pass);
        if (!envOk) note = 'Điều kiện thị trường chưa an toàn — không hỏi AI';
        else if (now - this.lastAiCallAt >= cfg.AI_MIN_INTERVAL_SEC * 1000) {
          decision = await this.askAI(now, g, candidate);
          const sideOk =
            (decision.action === 'BUY' && g.strategy.bias === 'up') ||
            (decision.action === 'SELL' && g.strategy.bias === 'down');
          if (sideOk && decision.confidence >= cfg.AI_MIN_CONFIDENCE && decision.stopLoss && decision.takeProfit) {
            const q = g.snap.quote;
            order = {
              side: decision.action as Side,
              refEntry: decision.action === 'BUY' ? q.ask : q.bid,
              stopLoss: decision.stopLoss,
              takeProfit: decision.takeProfit,
              source: 'ai',
              reasoning: decision.reasoning,
              confidence: decision.confidence,
            };
          }
        }
      }

      if (order) note = await this.execute(order);
      this.status.lastAction = note;
      if (decision) {
        await orders.recordDecision({
          time: now,
          mode: cfg.AI_MODE,
          candidate,
          decision,
          executed: note.startsWith('Đã mở'),
          note,
        });
      }
    } catch (e) {
      this.status.lastError = errMsg(e);
      logger.error('Engine tick lỗi', e);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Kiểm tra lại mọi thứ ngay trước khi gửi lệnh (sau khi chờ AI vài giây, thị trường có thể đã khác):
   * giá còn realtime, phiên/tin/rủi ro, giá không trượt quá MAX_ENTRY_DRIFT_R × rủi ro.
   */
  private async preflight(order: PlannedOrder): Promise<{ quote: Quote; account: AccountInfo } | string> {
    const { broker, cfg } = this.d;
    const now = Date.now();
    const [quote, account, positions] = await Promise.all([broker.getQuote(), broker.getAccount(), broker.getPositions()]);
    const problems = this.gateBlocks(account, positions, quote, now);
    if (now - quote.time > cfg.MAX_DATA_DELAY_SEC * 1000) problems.push('Giá broker không cập nhật');

    const entry = order.side === 'BUY' ? quote.ask : quote.bid;
    const riskDist = Math.abs(order.refEntry - order.stopLoss);
    const drift = Math.abs(entry - order.refEntry);
    if (drift > cfg.MAX_ENTRY_DRIFT_R * riskDist) {
      problems.push(`Giá đã chạy ${round(drift)} khỏi điểm vào phân tích (cho phép ${round(cfg.MAX_ENTRY_DRIFT_R * riskDist)})`);
    }
    return problems.length ? problems.join('; ') : { quote, account };
  }

  private async execute(order: PlannedOrder): Promise<string> {
    const { risk, broker, orders, cfg } = this.d;
    const pre = await this.preflight(order);
    if (typeof pre === 'string') {
      logger.warn(`Hủy lệnh ${order.side} ở bước kiểm tra cuối: ${pre}`);
      return `Bỏ lệnh: ${pre}`;
    }
    const { quote, account } = pre;
    const entry = order.side === 'BUY' ? quote.ask : quote.bid;
    const digits = cfg.PRICE_DIGITS;
    const sl = round(order.stopLoss, digits);
    const tp = round(order.takeProfit, digits);

    const invalid = risk.validateOrder(order.side, entry, sl, tp);
    if (invalid) {
      logger.warn(`Bỏ lệnh ${order.side}: ${invalid}`);
      return `Bỏ lệnh: ${invalid}`;
    }
    const volume = risk.calcLot(account.balance, entry, sl);
    if (volume <= 0) return 'Bỏ lệnh: khối lượng nhỏ hơn MIN_LOT với mức rủi ro cho phép';

    const positionId = await broker.openPosition({ side: order.side, volume, stopLoss: sl, takeProfit: tp, comment: `xau-bot ${order.source}` });
    await risk.registerOpened();
    const riskUsd = round(Math.abs(entry - sl) * volume * cfg.CONTRACT_SIZE);
    const saved = await orders.upsertOpen({
      positionId,
      symbol: cfg.SYMBOL,
      side: order.side,
      volume,
      entryPrice: entry,
      initialSL: sl,
      takeProfit: tp,
      source: order.source,
      aiConfidence: order.confidence,
      reasoning: order.reasoning,
      openedAt: Date.now(),
    });
    await orders.addEvent(saved.id, 'OPENED', `${order.side} ${volume} lot @ ${entry} SL ${sl} TP ${tp}`, {
      riskUsd,
      source: order.source,
      refEntry: order.refEntry,
      checklist: this.status.checklist.filter((c) => c.pass).map((c) => c.id),
    });
    logger.info(`MỞ #${saved.id} ${order.side} ${volume} lot @ ${entry} SL ${sl} TP ${tp} (rủi ro ${riskUsd} USD, nguồn ${order.source})`);
    return `Đã mở ${order.side} ${volume} lot @ ${entry}`;
  }

  /** Phân tích một lần (không giao dịch) — dùng cho API /analyze. */
  async analyzeOnly() {
    const now = Date.now();
    const g = await this.gather(now);
    const context = await this.buildContext(now, g, g.strategy.candidate);
    const decision = this.d.analyst.enabled ? await this.d.analyst.decide(context) : null;
    return {
      blockedReasons: g.blocks,
      strategy: g.strategy,
      decision,
      context: JSON.parse(context) as unknown,
      contextChars: context.length,
    };
  }
}
