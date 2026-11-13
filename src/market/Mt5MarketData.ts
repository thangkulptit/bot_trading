import type { Candle, Quote, Timeframe } from '../types';
import type { MarketData } from './MarketData';
import type { Mt5BridgeClient } from './Mt5BridgeClient';

/** Nến và giá từ chính chart XAUUSD trên terminal MT5 (qua bridge). */
export class Mt5MarketData implements MarketData {
  readonly name = 'mt5';

  constructor(private client: Mt5BridgeClient) {}

  getCandles(tf: Timeframe, limit: number): Promise<Candle[]> {
    return this.client.getCandles(tf, limit);
  }

  getQuote(): Promise<Quote> {
    return this.client.getQuote();
  }
}
