import type { Candle, Quote, Timeframe } from '../types';
import type { MarketData } from './MarketData';
import type { MetaApiClient } from './MetaApiClient';

export class MetaApiMarketData implements MarketData {
  readonly name = 'metaapi';

  constructor(private client: MetaApiClient) {}

  getCandles(tf: Timeframe, limit: number): Promise<Candle[]> {
    return this.client.getCandles(tf, limit);
  }

  getQuote(): Promise<Quote> {
    return this.client.getQuote();
  }
}
