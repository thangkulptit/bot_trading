import path from 'node:path';
import type { Config } from '../config';
import { logger } from '../logger';
import type { AccountInfo, Position, Quote, Side } from '../types';
import { readJsonFile, round, utcDay, writeJsonFile } from '../utils';

interface RiskState {
  day: string;
  dayStartEquity: number;
  tradesToday: number;
  consecutiveLosses: number;
  cooldownUntil: number;
  haltReason: string | null;
}

export interface RiskSummary {
  day: string;
  dayStartEquity: number;
  dailyPnl: number;
  dailyPnlPct: number;
  tradesToday: number;
  consecutiveLosses: number;
  cooldownUntil: number | null;
  haltReason: string | null;
}

/**
 * Lớp kỷ luật cứng: AI và chiến lược KHÔNG thể vượt qua các giới hạn này.
 * Ngày giao dịch tính theo UTC.
 */
export class RiskManager {
  private state: RiskState = {
    day: '',
    dayStartEquity: 0,
    tradesToday: 0,
    consecutiveLosses: 0,
    cooldownUntil: 0,
    haltReason: null,
  };
  private readonly file: string;

  constructor(private cfg: Config) {
    this.file = path.join(cfg.DATA_DIR, 'risk-state.json');
  }

  async init(): Promise<void> {
    this.state = await readJsonFile(this.file, this.state);
  }

  private save(): Promise<void> {
    return writeJsonFile(this.file, this.state);
  }

  async refreshDay(account: AccountInfo, now = Date.now()): Promise<void> {
    const day = utcDay(now);
    if (this.state.day === day) return;
    this.state = {
      day,
      dayStartEquity: account.equity,
      tradesToday: 0,
      consecutiveLosses: 0,
      cooldownUntil: 0,
      haltReason: null,
    };
    logger.info(`Ngày giao dịch mới ${day}, equity đầu ngày ${round(account.equity)}`);
    await this.save();
  }

  private dailyPnlPct(account: AccountInfo): number {
    if (!this.state.dayStartEquity) return 0;
    return ((account.equity - this.state.dayStartEquity) / this.state.dayStartEquity) * 100;
  }

  summary(account: AccountInfo): RiskSummary {
    return {
      day: this.state.day,
      dayStartEquity: this.state.dayStartEquity,
      dailyPnl: round(account.equity - this.state.dayStartEquity),
      dailyPnlPct: round(this.dailyPnlPct(account)),
      tradesToday: this.state.tradesToday,
      consecutiveLosses: this.state.consecutiveLosses,
      cooldownUntil: this.state.cooldownUntil > Date.now() ? this.state.cooldownUntil : null,
      haltReason: this.state.haltReason,
    };
  }

  /** Trả về danh sách lý do chặn vào lệnh mới (rỗng = được phép). */
  canOpen(account: AccountInfo, positions: Position[], quote: Quote, now = Date.now()): string[] {
    const reasons: string[] = [];
    const pnlPct = this.dailyPnlPct(account);
    if (this.state.haltReason) reasons.push(`Đã dừng giao dịch hôm nay: ${this.state.haltReason}`);
    if (pnlPct <= -this.cfg.MAX_DAILY_LOSS_PCT) reasons.push(`Chạm giới hạn lỗ ngày (${round(pnlPct)}%)`);
    if (this.cfg.MAX_DAILY_PROFIT_PCT > 0 && pnlPct >= this.cfg.MAX_DAILY_PROFIT_PCT) {
      reasons.push(`Đạt mục tiêu lãi ngày (${round(pnlPct)}%) — nghỉ, giữ thành quả`);
    }
    if (this.state.tradesToday >= this.cfg.MAX_DAILY_TRADES) reasons.push('Đủ số lệnh tối đa trong ngày');
    if (now < this.state.cooldownUntil) {
      reasons.push(`Đang nghỉ sau chuỗi thua đến ${new Date(this.state.cooldownUntil).toISOString().slice(11, 16)} UTC`);
    }
    if (positions.length >= this.cfg.MAX_OPEN_POSITIONS) reasons.push('Đã đạt số vị thế mở tối đa');
    const spread = quote.ask - quote.bid;
    if (spread > this.cfg.MAX_SPREAD) reasons.push(`Spread quá cao (${round(spread)})`);
    return reasons;
  }

  /** Trả về lý do cần đóng toàn bộ vị thế ngay, hoặc null. */
  async checkEmergency(account: AccountInfo, positions: Position[]): Promise<string | null> {
    const pnlPct = this.dailyPnlPct(account);
    if (pnlPct <= -this.cfg.MAX_DAILY_LOSS_PCT && !this.state.haltReason) {
      this.state.haltReason = `Lỗ ngày ${round(pnlPct)}% vượt ${this.cfg.MAX_DAILY_LOSS_PCT}%`;
      logger.warn(`HALT: ${this.state.haltReason}`);
      await this.save();
    }
    if (!positions.length) return null;
    if (this.state.haltReason) return this.state.haltReason;

    const floating = positions.reduce((s, p) => s + p.profit, 0);
    const floatingPct = (floating / account.balance) * 100;
    if (floatingPct <= -this.cfg.MAX_FLOATING_LOSS_PCT) {
      return `Lỗ thả nổi ${round(floatingPct)}% vượt ${this.cfg.MAX_FLOATING_LOSS_PCT}%`;
    }
    return null;
  }

  async halt(reason: string): Promise<void> {
    this.state.haltReason = reason;
    await this.save();
  }

  async registerOpened(): Promise<void> {
    this.state.tradesToday++;
    await this.save();
  }

  async registerClosedTrade(profit: number, now = Date.now()): Promise<void> {
    if (profit < 0) {
      this.state.consecutiveLosses++;
      if (this.state.consecutiveLosses >= this.cfg.MAX_CONSECUTIVE_LOSSES) {
        this.state.cooldownUntil = now + this.cfg.COOLDOWN_AFTER_LOSS_STREAK_MIN * 60_000;
        logger.warn(
          `Thua ${this.state.consecutiveLosses} lệnh liên tiếp → nghỉ ${this.cfg.COOLDOWN_AFTER_LOSS_STREAK_MIN} phút`,
        );
        this.state.consecutiveLosses = 0;
      }
    } else if (profit > 0) {
      this.state.consecutiveLosses = 0;
    }
    await this.save();
  }

  /** Khối lượng theo % rủi ro: lot = risk$ / (khoảng SL × contract size). 0 = không đủ điều kiện. */
  calcLot(balance: number, entry: number, stopLoss: number): number {
    const riskUsd = (balance * this.cfg.RISK_PER_TRADE_PCT) / 100;
    const dist = Math.abs(entry - stopLoss);
    if (dist <= 0) return 0;
    const raw = riskUsd / (dist * this.cfg.CONTRACT_SIZE);
    const lot = Math.min(Math.floor(raw / this.cfg.LOT_STEP + 1e-9) * this.cfg.LOT_STEP, this.cfg.MAX_LOT);
    return lot < this.cfg.MIN_LOT ? 0 : round(lot, 2);
  }

  /** Kiểm tra hình học lệnh. Trả về lý do lỗi hoặc null nếu hợp lệ. */
  validateOrder(side: Side, entry: number, stopLoss: number, takeProfit: number): string | null {
    const dir = side === 'BUY' ? 1 : -1;
    const risk = (entry - stopLoss) * dir;
    const reward = (takeProfit - entry) * dir;
    if (risk <= 0) return 'SL nằm sai phía';
    if (reward <= 0) return 'TP nằm sai phía';
    if (risk < this.cfg.MIN_SL) return `SL quá gần (${round(risk)} < ${this.cfg.MIN_SL})`;
    if (risk > this.cfg.MAX_SL) return `SL quá xa (${round(risk)} > ${this.cfg.MAX_SL})`;
    if (reward / risk < this.cfg.MIN_RR) return `R:R ${round(reward / risk)} < ${this.cfg.MIN_RR}`;
    return null;
  }
}
