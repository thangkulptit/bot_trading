import path from 'node:path';
import type { Config } from '../config';
import { logger } from '../logger';
import type { MarketData } from '../market/MarketData';
import type { AccountInfo, OpenOrderRequest, Position, Quote } from '../types';
import { readJsonFile, round, writeJsonFile } from '../utils';
import type { Broker } from './Broker';

interface PaperState {
  balance: number;
  seq: number;
  positions: Position[];
  realized: Record<string, number>;
}

const MAX_REALIZED_HISTORY = 500;

/** Mô phỏng khớp lệnh bằng giá thật từ MarketData. SL/TP được kiểm tra mỗi lần đọc giá. */
export class PaperBroker implements Broker {
  readonly name = 'paper';
  private state: PaperState;
  private readonly file: string;

  constructor(
    private md: MarketData,
    private cfg: Config,
  ) {
    this.file = path.join(cfg.DATA_DIR, 'paper-account.json');
    this.state = { balance: cfg.PAPER_START_BALANCE, seq: 0, positions: [], realized: {} };
  }

  async init(): Promise<void> {
    this.state = await readJsonFile(this.file, this.state);
    logger.info(`Paper account: balance ${round(this.state.balance)} USD, ${this.state.positions.length} vị thế mở`);
  }

  private save(): Promise<void> {
    return writeJsonFile(this.file, this.state);
  }

  private pnl(p: Position, price: number): number {
    const dir = p.side === 'BUY' ? 1 : -1;
    return round((price - p.openPrice) * dir * p.volume * this.cfg.CONTRACT_SIZE);
  }

  private markInFlight: Promise<Quote> | null = null;

  /** Gộp các lần gọi đồng thời để một SL/TP không bị khớp hai lần. */
  private mark(): Promise<Quote> {
    this.markInFlight ??= this.doMark().finally(() => {
      this.markInFlight = null;
    });
    return this.markInFlight;
  }

  private async doMark(): Promise<Quote> {
    const q = await this.md.getQuote();
    for (const p of [...this.state.positions]) {
      const exitPrice = p.side === 'BUY' ? q.bid : q.ask;
      p.currentPrice = exitPrice;
      p.profit = this.pnl(p, exitPrice);

      const hitSL = p.stopLoss && (p.side === 'BUY' ? exitPrice <= p.stopLoss : exitPrice >= p.stopLoss);
      const hitTP = p.takeProfit && (p.side === 'BUY' ? exitPrice >= p.takeProfit : exitPrice <= p.takeProfit);
      if (hitSL) await this.closeAt(p, p.stopLoss!, 'SL');
      else if (hitTP) await this.closeAt(p, p.takeProfit!, 'TP');
    }
    return q;
  }

  private async closeAt(p: Position, price: number, tag: string): Promise<void> {
    if (!this.state.positions.some((x) => x.id === p.id)) return;
    const profit = this.pnl(p, price);
    this.state.balance = round(this.state.balance + profit);
    this.state.positions = this.state.positions.filter((x) => x.id !== p.id);
    this.state.realized[p.id] = profit;
    const keys = Object.keys(this.state.realized);
    if (keys.length > MAX_REALIZED_HISTORY) delete this.state.realized[keys[0]];
    logger.info(`[paper] Đóng ${p.side} ${p.id} @ ${price} (${tag}) P/L ${profit} USD`);
    await this.save();
  }

  getQuote(): Promise<Quote> {
    return this.md.getQuote();
  }

  async getAccount(): Promise<AccountInfo> {
    await this.mark();
    const floating = this.state.positions.reduce((s, p) => s + p.profit, 0);
    return { balance: this.state.balance, equity: round(this.state.balance + floating), currency: 'USD' };
  }

  async getPositions(): Promise<Position[]> {
    await this.mark();
    return this.state.positions.map((p) => ({ ...p }));
  }

  async openPosition(req: OpenOrderRequest): Promise<string> {
    const q = await this.md.getQuote();
    const price = req.side === 'BUY' ? q.ask : q.bid;
    const id = `P${++this.state.seq}`;
    this.state.positions.push({
      id,
      symbol: this.cfg.SYMBOL,
      side: req.side,
      volume: req.volume,
      openPrice: price,
      currentPrice: price,
      stopLoss: req.stopLoss,
      takeProfit: req.takeProfit,
      profit: 0,
      openTime: Date.now(),
      comment: req.comment,
    });
    await this.save();
    return id;
  }

  async closePosition(id: string): Promise<void> {
    const q = await this.md.getQuote();
    const p = this.state.positions.find((x) => x.id === id);
    if (!p) return;
    await this.closeAt(p, p.side === 'BUY' ? q.bid : q.ask, 'MANUAL');
  }

  async modifyPosition(id: string, stopLoss?: number, takeProfit?: number): Promise<void> {
    const p = this.state.positions.find((x) => x.id === id);
    if (!p) throw new Error(`Không tìm thấy vị thế ${id}`);
    p.stopLoss = stopLoss;
    p.takeProfit = takeProfit;
    await this.save();
  }

  async getRealizedProfit(id: string): Promise<number | undefined> {
    return this.state.realized[id];
  }
}
