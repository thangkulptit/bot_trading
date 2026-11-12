import type { AccountInfo, Candle, Position, Quote, Timeframe } from '../types';
import { fetchJson } from '../utils';

interface MetaApiPosition {
  id: string;
  type: string;
  symbol: string;
  volume: number;
  openPrice: number;
  currentPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  profit: number;
  swap?: number;
  commission?: number;
  time: string;
  comment?: string;
}

interface MetaApiTradeResponse {
  numericCode: number;
  stringCode: string;
  message: string;
  orderId?: string;
  positionId?: string;
}

const TRADE_OK_CODES = new Set([10008, 10009, 10010]);

/** REST client tối giản cho MetaApi (metaapi.cloud) — kết nối tài khoản MT4/MT5. */
export class MetaApiClient {
  private readonly clientBase: string;
  private readonly marketBase: string;

  constructor(
    private token: string,
    accountId: string,
    region: string,
    readonly symbol: string,
  ) {
    this.clientBase = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}`;
    this.marketBase = `https://mt-market-data-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}`;
  }

  private req<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    return fetchJson<T>(url, {
      method,
      headers: { 'auth-token': this.token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 15000,
    });
  }

  async getQuote(): Promise<Quote> {
    const p = await this.req<{ bid: number; ask: number; time: string }>(
      `${this.clientBase}/symbols/${encodeURIComponent(this.symbol)}/current-price`,
    );
    return { bid: p.bid, ask: p.ask, time: Date.parse(p.time) || Date.now() };
  }

  async getCandles(tf: Timeframe, limit: number): Promise<Candle[]> {
    const rows = await this.req<
      Array<{ time: string; open: number; high: number; low: number; close: number; tickVolume?: number }>
    >(
      `${this.marketBase}/historical-market-data/symbols/${encodeURIComponent(this.symbol)}/timeframes/${tf}/candles?limit=${limit}`,
    );
    return rows
      .map((r) => ({
        time: Date.parse(r.time),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.tickVolume ?? 0,
      }))
      .sort((a, b) => a.time - b.time);
  }

  getSymbols(): Promise<string[]> {
    return this.req<string[]>(`${this.clientBase}/symbols`);
  }

  async getAccount(): Promise<AccountInfo> {
    const a = await this.req<{ balance: number; equity: number; currency: string }>(
      `${this.clientBase}/account-information`,
    );
    return { balance: a.balance, equity: a.equity, currency: a.currency };
  }

  async getPositions(): Promise<Position[]> {
    const rows = await this.req<MetaApiPosition[]>(`${this.clientBase}/positions`);
    return rows
      .filter((p) => p.symbol === this.symbol)
      .map((p) => ({
        id: String(p.id),
        symbol: p.symbol,
        side: p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL',
        volume: p.volume,
        openPrice: p.openPrice,
        currentPrice: p.currentPrice,
        stopLoss: p.stopLoss || undefined,
        takeProfit: p.takeProfit || undefined,
        profit: p.profit + (p.swap ?? 0) + (p.commission ?? 0),
        openTime: Date.parse(p.time),
        comment: p.comment,
      }));
  }

  async trade(body: Record<string, unknown>): Promise<MetaApiTradeResponse> {
    const res = await this.req<MetaApiTradeResponse>(`${this.clientBase}/trade`, 'POST', body);
    if (!TRADE_OK_CODES.has(res.numericCode)) {
      throw new Error(`Lệnh bị từ chối: ${res.stringCode} (${res.numericCode}) ${res.message}`);
    }
    return res;
  }

  async getRealizedProfit(positionId: string): Promise<number | undefined> {
    const deals = await this.req<Array<{ profit?: number; commission?: number; swap?: number }>>(
      `${this.clientBase}/history-deals/position/${encodeURIComponent(positionId)}`,
    );
    if (!deals.length) return undefined;
    return deals.reduce((s, d) => s + (d.profit ?? 0) + (d.commission ?? 0) + (d.swap ?? 0), 0);
  }
}
