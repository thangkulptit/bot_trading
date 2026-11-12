import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AIDecision, OrderStatus, Position, Side, SignalCandidate, TradeOrder } from '../types';

interface OrderRow extends RowDataPacket {
  id: number;
  broker: string;
  position_id: string;
  symbol: string;
  side: Side;
  status: OrderStatus;
  volume: number;
  entry_price: number;
  initial_sl: number | null;
  current_sl: number | null;
  take_profit: number | null;
  current_price: number | null;
  floating_profit: number | null;
  close_price: number | null;
  profit: number | null;
  r_multiple: number | null;
  close_reason: string | null;
  source: string;
  ai_confidence: number | null;
  reasoning: string | null;
  opened_at: Date;
  closed_at: Date | null;
}

interface EventRow extends RowDataPacket {
  id: number;
  type: string;
  message: string;
  data: unknown;
  created_at: Date;
}

interface DecisionRow extends RowDataPacket {
  mode: string;
  action: AIDecision['action'];
  confidence: number;
  stop_loss: number | null;
  take_profit: number | null;
  reasoning: string | null;
  risk_notes: string | null;
  candidate: SignalCandidate | null;
  executed: number;
  note: string | null;
  created_at: Date;
}

export interface NewOrder {
  positionId: string;
  symbol: string;
  side: Side;
  volume: number;
  entryPrice: number;
  initialSL: number | null;
  takeProfit: number | null;
  source: string;
  aiConfidence?: number;
  reasoning?: string;
  openedAt: number;
}

export interface CloseInfo {
  closePrice: number;
  profit: number;
  rMultiple: number | null;
  reason: string;
  closedAt: number;
}

export interface DecisionLog {
  time: number;
  mode: string;
  candidate: SignalCandidate | null;
  decision: AIDecision;
  executed: boolean;
  note?: string;
}

export type OrderEventType =
  | 'OPENED'
  | 'EXTERNAL_DETECTED'
  | 'SL_MOVED'
  | 'SL_ENFORCED'
  | 'CLOSE_REQUESTED'
  | 'CLOSED';

const toOrder = (r: OrderRow): TradeOrder => ({
  id: r.id,
  broker: r.broker,
  positionId: r.position_id,
  symbol: r.symbol,
  side: r.side,
  status: r.status,
  volume: r.volume,
  entryPrice: r.entry_price,
  initialSL: r.initial_sl,
  currentSL: r.current_sl,
  takeProfit: r.take_profit,
  currentPrice: r.current_price,
  floatingProfit: r.floating_profit,
  closePrice: r.close_price,
  profit: r.profit,
  rMultiple: r.r_multiple,
  closeReason: r.close_reason,
  source: r.source,
  aiConfidence: r.ai_confidence,
  reasoning: r.reasoning,
  openedAt: r.opened_at.getTime(),
  closedAt: r.closed_at ? r.closed_at.getTime() : null,
});

const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** Lưu trữ lệnh theo từng broker (paper và live không lẫn vào nhau). */
export class OrderRepository {
  constructor(
    private pool: Pool,
    private broker: string,
  ) {}

  private insertValues(o: NewOrder) {
    return [
      this.broker,
      o.positionId,
      o.symbol,
      o.side,
      o.volume,
      o.entryPrice,
      o.initialSL,
      o.initialSL,
      o.takeProfit,
      o.entryPrice,
      o.source,
      orNull(o.aiConfidence),
      orNull(o.reasoning),
      new Date(o.openedAt),
    ];
  }

  private static readonly INSERT_SQL = `INTO orders
    (broker, position_id, symbol, side, status, volume, entry_price, initial_sl, current_sl, take_profit,
     current_price, floating_profit, source, ai_confidence, reasoning, opened_at)
    VALUES (?, ?, ?, ?, 'LIVE', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`;

  /** Lệnh do bot mở. Nếu monitor đã kịp ghi nhận vị thế này là "external" thì ghi đè thông tin gốc. */
  async upsertOpen(o: NewOrder): Promise<TradeOrder> {
    await this.pool.query(
      `INSERT ${OrderRepository.INSERT_SQL}
       ON DUPLICATE KEY UPDATE initial_sl = VALUES(initial_sl), source = VALUES(source),
         ai_confidence = VALUES(ai_confidence), reasoning = VALUES(reasoning)`,
      this.insertValues(o),
    );
    return (await this.findByPositionId(o.positionId))!;
  }

  /** Vị thế mở ngoài bot (thủ công trên MT5...). Không ghi đè nếu đã tồn tại. */
  async insertExternal(o: NewOrder): Promise<{ order: TradeOrder; created: boolean }> {
    const [res] = await this.pool.query<ResultSetHeader>(`INSERT IGNORE ${OrderRepository.INSERT_SQL}`, this.insertValues(o));
    return { order: (await this.findByPositionId(o.positionId))!, created: res.affectedRows > 0 };
  }

  async findById(id: number): Promise<TradeOrder | null> {
    const [rows] = await this.pool.query<OrderRow[]>('SELECT * FROM orders WHERE id = ?', [id]);
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async findByPositionId(positionId: string): Promise<TradeOrder | null> {
    const [rows] = await this.pool.query<OrderRow[]>('SELECT * FROM orders WHERE broker = ? AND position_id = ?', [
      this.broker,
      positionId,
    ]);
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async findLive(): Promise<TradeOrder[]> {
    const [rows] = await this.pool.query<OrderRow[]>(
      "SELECT * FROM orders WHERE broker = ? AND status = 'LIVE' ORDER BY opened_at",
      [this.broker],
    );
    return rows.map(toOrder);
  }

  async list(status: OrderStatus | undefined, limit: number): Promise<TradeOrder[]> {
    const [rows] = await this.pool.query<OrderRow[]>(
      `SELECT * FROM orders WHERE broker = ? ${status ? 'AND status = ?' : ''} ORDER BY opened_at DESC LIMIT ?`,
      status ? [this.broker, status, limit] : [this.broker, limit],
    );
    return rows.map(toOrder);
  }

  /** Cập nhật trạng thái realtime của lệnh LIVE theo dữ liệu broker. */
  async syncLive(id: number, p: Position): Promise<void> {
    await this.pool.query(
      `UPDATE orders SET entry_price = ?, volume = ?, current_price = ?, floating_profit = ?, current_sl = ?, take_profit = ?
       WHERE id = ? AND status = 'LIVE'`,
      [p.openPrice, p.volume, p.currentPrice, p.profit, orNull(p.stopLoss), orNull(p.takeProfit), id],
    );
  }

  /** Trả về false nếu lệnh đã CLOSED từ trước. */
  async markClosed(id: number, c: CloseInfo): Promise<boolean> {
    const [res] = await this.pool.query<ResultSetHeader>(
      `UPDATE orders SET status = 'CLOSED', close_price = ?, current_price = ?, profit = ?, floating_profit = NULL,
         r_multiple = ?, close_reason = ?, closed_at = ?
       WHERE id = ? AND status = 'LIVE'`,
      [c.closePrice, c.closePrice, c.profit, c.rMultiple, c.reason.slice(0, 255), new Date(c.closedAt), id],
    );
    return res.affectedRows > 0;
  }

  async addEvent(orderId: number, type: OrderEventType, message: string, data?: unknown): Promise<void> {
    await this.pool.query('INSERT INTO order_events (order_id, type, message, data) VALUES (?, ?, ?, ?)', [
      orderId,
      type,
      message.slice(0, 500),
      data === undefined ? null : JSON.stringify(data),
    ]);
  }

  async events(orderId: number) {
    const [rows] = await this.pool.query<EventRow[]>(
      'SELECT id, type, message, data, created_at FROM order_events WHERE order_id = ? ORDER BY id',
      [orderId],
    );
    return rows.map((r) => ({ id: r.id, type: r.type, message: r.message, data: r.data, time: r.created_at.getTime() }));
  }

  /** Các lệnh đã đóng gần nhất, theo thứ tự thời gian tăng dần. */
  async recentClosed(n: number): Promise<TradeOrder[]> {
    const [rows] = await this.pool.query<OrderRow[]>(
      "SELECT * FROM orders WHERE broker = ? AND status = 'CLOSED' ORDER BY closed_at DESC LIMIT ?",
      [this.broker, n],
    );
    return rows.map(toOrder).reverse();
  }

  async todayStats(now = Date.now()) {
    const dayStart = new Date(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z');
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS trades, COALESCE(SUM(profit > 0), 0) AS wins, COALESCE(SUM(profit < 0), 0) AS losses,
         COALESCE(SUM(profit), 0) AS pnl
       FROM orders WHERE broker = ? AND status = 'CLOSED' AND closed_at >= ?`,
      [this.broker, dayStart],
    );
    const r = rows[0];
    const trades = Number(r.trades);
    const wins = Number(r.wins);
    return {
      trades,
      wins,
      losses: Number(r.losses),
      winRate: trades ? Math.round((wins / trades) * 100) : null,
      realizedPnl: Math.round(Number(r.pnl) * 100) / 100,
    };
  }

  async recordDecision(log: DecisionLog): Promise<void> {
    const d = log.decision;
    await this.pool.query(
      `INSERT INTO ai_decisions (mode, action, confidence, stop_loss, take_profit, reasoning, risk_notes, candidate, executed, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        log.mode,
        d.action,
        d.confidence,
        orNull(d.stopLoss),
        orNull(d.takeProfit),
        d.reasoning,
        orNull(d.riskNotes),
        log.candidate ? JSON.stringify(log.candidate) : null,
        log.executed ? 1 : 0,
        orNull(log.note),
        new Date(log.time),
      ],
    );
  }

  async recentDecisions(n: number): Promise<DecisionLog[]> {
    const [rows] = await this.pool.query<DecisionRow[]>('SELECT * FROM ai_decisions ORDER BY id DESC LIMIT ?', [n]);
    return rows.reverse().map((r) => ({
      time: r.created_at.getTime(),
      mode: r.mode,
      candidate: r.candidate,
      executed: Boolean(r.executed),
      note: r.note ?? undefined,
      decision: {
        action: r.action,
        confidence: r.confidence,
        stopLoss: r.stop_loss ?? undefined,
        takeProfit: r.take_profit ?? undefined,
        reasoning: r.reasoning ?? '',
        riskNotes: r.risk_notes ?? undefined,
      },
    }));
  }
}
