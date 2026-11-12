import type { Config } from '../config';
import { aggregate } from '../indicators';
import type { Candle, Quote, Timeframe } from '../types';
import { fetchJson, round } from '../utils';
import type { MarketData } from './MarketData';

interface YahooChart {
  chart: {
    result: Array<{
      timestamp?: number[];
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
      };
    }> | null;
    error: { description?: string } | null;
  };
}

const RANGE: Record<Exclude<Timeframe, '4h'>, string> = { '1m': '1d', '5m': '5d', '15m': '5d', '1h': '3mo' };
const H4_MS = 4 * 3600_000;
const CACHE_TTL_MS = 4000;

/**
 * Nguồn dữ liệu miễn phí cho paper trading. Yahoo không có XAUUSD spot nên dùng
 * hợp đồng tương lai vàng (GC=F): lệch spot vài USD và có thể trễ vài phút.
 */
export class YahooMarketData implements MarketData {
  readonly name = 'yahoo';
  private cache = new Map<string, { at: number; data: Candle[] }>();

  constructor(private cfg: Config) {}

  async getCandles(tf: Timeframe, limit: number): Promise<Candle[]> {
    // Yahoo không có khung 4h → gộp từ H1
    if (tf === '4h') return aggregate(await this.getCandles('1h', 5000), H4_MS).slice(-limit);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      this.cfg.YAHOO_SYMBOL,
    )}?interval=${tf}&range=${RANGE[tf]}`;
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data.slice(-limit);

    const json = await fetchJson<YahooChart>(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const result = json.chart.result?.[0];
    if (!result?.timestamp) throw new Error(`Yahoo không trả dữ liệu: ${json.chart.error?.description ?? 'unknown'}`);

    const q = result.indicators.quote[0];
    const candles: Candle[] = [];
    result.timestamp.forEach((ts, i) => {
      const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
      if (o == null || h == null || l == null || c == null) return;
      candles.push({ time: ts * 1000, open: o, high: h, low: l, close: c, volume: q.volume[i] ?? 0 });
    });
    this.cache.set(url, { at: Date.now(), data: candles });
    return candles.slice(-limit);
  }

  async getQuote(): Promise<Quote> {
    const candles = await this.getCandles('1m', 2);
    if (!candles.length) throw new Error('Không có giá hiện tại từ Yahoo');
    const mid = candles[candles.length - 1].close;
    const half = this.cfg.PAPER_SPREAD / 2;
    const d = this.cfg.PRICE_DIGITS;
    return { bid: round(mid - half, d), ask: round(mid + half, d), time: Date.now() };
  }
}
