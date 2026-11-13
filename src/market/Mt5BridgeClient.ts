import type { AccountInfo, Candle, OpenOrderRequest, Position, Quote, Side, Timeframe } from '../types';

interface BridgePosition {
  ticket: string;
  symbol: string;
  side: Side;
  volume: number;
  open_price: number;
  current_price: number;
  sl: number | null;
  tp: number | null;
  profit: number;
  open_time: number;
  comment: string;
  magic: number;
}

export interface BridgeHealth {
  connected: boolean;
  algo_trading: boolean;
  account_trade_allowed: boolean;
  login: number | null;
  server: string | null;
  company: string | null;
  server_utc_offset_hours: number;
}

/** Client cho bridge/mt5_bridge.py (Python + thư viện MetaTrader5 chạy cạnh terminal MT5). */
export class Mt5BridgeClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private token: string,
    readonly symbol: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async req<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'x-bridge-token': this.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const detail = (data as { detail?: unknown } | undefined)?.detail;
      const d = typeof detail === 'object' && detail !== null ? (detail as { message?: string; retcode?: number }) : {};
      const msg = typeof detail === 'string' ? detail : (d.message ?? text.slice(0, 300));
      throw new Error(`MT5 bridge ${res.status}: ${msg}${d.retcode ? ` (retcode ${d.retcode})` : ''}`);
    }
    return data as T;
  }

  private sym(): string {
    return encodeURIComponent(this.symbol);
  }

  health(): Promise<BridgeHealth> {
    return this.req(`/health?symbol=${this.sym()}`);
  }

  getSymbols(filter = ''): Promise<string[]> {
    return this.req(`/symbols?filter=${encodeURIComponent(filter)}`);
  }

  getQuote(): Promise<Quote> {
    return this.req(`/quote/${this.sym()}`);
  }

  getCandles(tf: Timeframe, limit: number): Promise<Candle[]> {
    return this.req(`/candles/${this.sym()}?tf=${tf}&count=${limit}`);
  }

  async getAccount(): Promise<AccountInfo> {
    const a = await this.req<{ balance: number; equity: number; currency: string }>('/account');
    return { balance: a.balance, equity: a.equity, currency: a.currency };
  }

  async getPositions(): Promise<Position[]> {
    const rows = await this.req<BridgePosition[]>(`/positions?symbol=${this.sym()}`);
    return rows.map((p) => ({
      id: p.ticket,
      symbol: p.symbol,
      side: p.side,
      volume: p.volume,
      openPrice: p.open_price,
      currentPrice: p.current_price,
      stopLoss: p.sl ?? undefined,
      takeProfit: p.tp ?? undefined,
      profit: p.profit,
      openTime: p.open_time,
      comment: p.comment,
    }));
  }

  async openPosition(req: OpenOrderRequest): Promise<string> {
    const res = await this.req<{ ticket: string }>('/orders', 'POST', {
      symbol: this.symbol,
      side: req.side,
      volume: req.volume,
      sl: req.stopLoss,
      tp: req.takeProfit,
      comment: req.comment ?? 'xau-bot',
    });
    return res.ticket;
  }

  async modifyPosition(id: string, stopLoss?: number, takeProfit?: number): Promise<void> {
    await this.req(`/positions/${encodeURIComponent(id)}/modify`, 'POST', { sl: stopLoss ?? null, tp: takeProfit ?? null });
  }

  async closePosition(id: string): Promise<void> {
    await this.req(`/positions/${encodeURIComponent(id)}/close`, 'POST');
  }

  async getRealizedProfit(id: string): Promise<number | undefined> {
    const r = await this.req<{ deals: number; closed: boolean; profit: number }>(
      `/deals/position/${encodeURIComponent(id)}`,
    );
    return r.closed ? r.profit : undefined;
  }
}
