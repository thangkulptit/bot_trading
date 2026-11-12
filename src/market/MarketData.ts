import type { Candle, Quote, Timeframe } from '../types';

export interface MarketData {
  readonly name: string;
  getCandles(tf: Timeframe, limit: number): Promise<Candle[]>;
  getQuote(): Promise<Quote>;
}
