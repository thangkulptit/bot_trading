import type { Broker } from '../broker/Broker';
import type { Config } from '../config';
import type { OrderRepository } from '../db/OrderRepository';
import { logger } from '../logger';
import type { NewsService } from '../news/NewsService';
import type { RiskManager } from '../risk/RiskManager';
import type { Position, TradeOrder } from '../types';
import { errMsg, round } from '../utils';

export interface MonitorDeps {
  cfg: Config;
  broker: Broker;
  news: NewsService;
  risk: RiskManager;
  orders: OrderRepository;
  /** ATR(M5) mới nhất cho trailing stop; NaN nếu chưa có. */
  getAtr: () => number;
}

/**
 * Luôn chạy (kể cả khi engine dừng) để bảo vệ vị thế.
 * Nguồn sự thật cho "lệnh đang quản lý" là các dòng status=LIVE trong DB, đối chiếu với broker mỗi tick:
 *  - LIVE trong DB nhưng không còn trên broker → chốt CLOSED (kể cả khi bị đóng lúc bot tắt).
 *  - Có trên broker nhưng chưa có trong DB → ghi nhận là lệnh external và quản lý luôn.
 */
export class PositionMonitor {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private closeReasons = new Map<string, string>();
  lastError: string | null = null;

  constructor(private d: MonitorDeps) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.d.cfg.MONITOR_INTERVAL_SEC * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const now = Date.now();
    try {
      const { broker, risk, news } = this.d;
      const [account, positions] = await Promise.all([broker.getAccount(), broker.getPositions()]);
      await risk.refreshDay(account, now);
      const tracked = await this.reconcile(positions, now);

      const emergency = await risk.checkEmergency(account, positions);
      if (emergency) {
        await this.closeAll(`RỦI RO: ${emergency}`, positions);
        return;
      }
      const event = news.eventRequiringFlat(now);
      if (event && positions.length) {
        await this.closeAll(`Đóng trước tin ${event.currency} ${event.title}`, positions);
        return;
      }
      for (const p of positions) {
        const order = tracked.get(p.id);
        if (order) await this.manage(p, order, now);
      }
      this.lastError = null;
    } catch (e) {
      this.lastError = errMsg(e);
      logger.error('Monitor lỗi', e);
    } finally {
      this.busy = false;
    }
  }

  async closeAll(reason: string, positions?: Position[]): Promise<number> {
    const list = positions ?? (await this.d.broker.getPositions());
    let closed = 0;
    for (const p of list) {
      try {
        await this.close(p.id, reason);
        closed++;
      } catch (e) {
        logger.error(`Không đóng được ${p.id}`, e);
      }
    }
    return closed;
  }

  async close(positionId: string, reason: string): Promise<void> {
    this.closeReasons.set(positionId, reason);
    const order = await this.d.orders.findByPositionId(positionId);
    if (order) await this.d.orders.addEvent(order.id, 'CLOSE_REQUESTED', reason);
    await this.d.broker.closePosition(positionId);
    logger.warn(`ĐÓNG ${positionId}: ${reason}`);
  }

  /** Đồng bộ DB ↔ broker. Trả về map positionId → order LIVE. */
  private async reconcile(positions: Position[], now: number): Promise<Map<string, TradeOrder>> {
    const { orders, cfg } = this.d;
    const live = await orders.findLive();
    const onBroker = new Set(positions.map((p) => p.id));

    for (const order of live) {
      if (!onBroker.has(order.positionId)) await this.finalize(order, now);
    }

    const tracked = new Map(live.filter((o) => onBroker.has(o.positionId)).map((o) => [o.positionId, o]));
    for (const p of positions) {
      let order = tracked.get(p.id);
      if (!order) {
        const res = await orders.insertExternal({
          positionId: p.id,
          symbol: p.symbol,
          side: p.side,
          volume: p.volume,
          entryPrice: p.openPrice,
          initialSL: p.stopLoss ?? null,
          takeProfit: p.takeProfit ?? null,
          source: 'external',
          openedAt: p.openTime,
        });
        order = res.order;
        if (res.created) {
          await orders.addEvent(order.id, 'EXTERNAL_DETECTED', `Phát hiện vị thế ngoài bot ${p.side} ${p.volume} lot @ ${p.openPrice}`);
          logger.warn(`Phát hiện vị thế ngoài bot ${p.id} (${p.side} ${p.volume} ${cfg.SYMBOL}) — đưa vào quản lý`);
        }
        tracked.set(p.id, order);
      }
      await orders.syncLive(order.id, p);
    }
    return tracked;
  }

  private async finalize(order: TradeOrder, now: number): Promise<void> {
    const { broker, orders, risk, cfg } = this.d;
    const realized = await broker.getRealizedProfit(order.positionId).catch(() => undefined);
    const profit = round(realized ?? order.floatingProfit ?? 0);
    const dir = order.side === 'BUY' ? 1 : -1;
    const closePrice =
      realized === undefined
        ? (order.currentPrice ?? order.entryPrice)
        : round(order.entryPrice + realized / (dir * order.volume * cfg.CONTRACT_SIZE), cfg.PRICE_DIGITS);
    const riskUsd = order.initialSL ? Math.abs(order.entryPrice - order.initialSL) * order.volume * cfg.CONTRACT_SIZE : 0;
    const rMultiple = riskUsd > 0 ? round(profit / riskUsd) : null;
    const reason = this.closeReasons.get(order.positionId) ?? 'Broker (SL/TP) hoặc đóng ngoài bot';
    this.closeReasons.delete(order.positionId);

    const updated = await orders.markClosed(order.id, { closePrice, profit, rMultiple, reason, closedAt: now });
    if (!updated) return;
    await orders.addEvent(order.id, 'CLOSED', reason, { closePrice, profit, rMultiple });
    await risk.registerClosedTrade(profit, now);
    logger.info(`Lệnh #${order.id} (${order.positionId}) ${order.side} CLOSED: ${profit >= 0 ? '+' : ''}${profit} USD (${reason})`);
  }

  private async manage(p: Position, order: TradeOrder, now: number): Promise<void> {
    const { cfg, broker, orders } = this.d;
    const dir = p.side === 'BUY' ? 1 : -1;
    const digits = cfg.PRICE_DIGITS;

    if (!p.stopLoss) {
      const sl = round(p.openPrice - dir * cfg.MAX_SL, digits);
      await broker.modifyPosition(p.id, sl, p.takeProfit);
      await orders.addEvent(order.id, 'SL_ENFORCED', `Không có SL → đặt SL bắt buộc ${sl}`);
      logger.warn(`Vị thế ${p.id} không có SL → đặt SL bắt buộc ${sl}`);
      return;
    }

    if (now - p.openTime > cfg.MAX_HOLD_MIN * 60_000) {
      await this.close(p.id, `Quá ${cfg.MAX_HOLD_MIN} phút — scalping không giữ lệnh lâu`);
      return;
    }

    const initialRisk = Math.abs(order.entryPrice - (order.initialSL ?? p.stopLoss));
    if (initialRisk <= 0) return;
    const r = ((p.currentPrice - p.openPrice) * dir) / initialRisk;

    const better = (a: number, b: number) => (dir === 1 ? a > b : a < b);
    let newSL = p.stopLoss;
    let why = '';

    if (r >= cfg.BREAKEVEN_AT_R) {
      const be = p.openPrice + dir * cfg.BREAKEVEN_OFFSET;
      if (better(be, newSL)) {
        newSL = be;
        why = `hòa vốn (${round(r)}R)`;
      }
    }
    const atr = this.d.getAtr();
    if (r >= cfg.TRAIL_START_R && Number.isFinite(atr)) {
      const trail = p.currentPrice - dir * cfg.TRAIL_ATR_MULT * atr;
      if (better(trail, newSL)) {
        newSL = trail;
        why = `trailing (${round(r)}R)`;
      }
    }

    const maxSL = p.currentPrice - dir * cfg.MIN_STOP_DISTANCE;
    if (better(newSL, maxSL)) newSL = maxSL;
    newSL = round(newSL, digits);

    if (better(newSL, p.stopLoss) && Math.abs(newSL - p.stopLoss) >= 0.05) {
      await broker.modifyPosition(p.id, newSL, p.takeProfit);
      await orders.addEvent(order.id, 'SL_MOVED', `${p.stopLoss} → ${newSL} [${why}]`, { from: p.stopLoss, to: newSL, r: round(r) });
      logger.info(`Dời SL ${p.id}: ${p.stopLoss} → ${newSL} [${why}]`);
    }
  }
}
