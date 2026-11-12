import type { Candle } from './types';

const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = avg(values.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const value = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

/** ADX (Wilder). > 20–25 = thị trường có xu hướng, < 20 = sideway/nhiễu. */
export function adx(candles: Candle[], period = 14): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period * 2 + 1) return out;
  const tr = new Array<number>(n).fill(0);
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    pS += plusDM[i];
    mS += minusDM[i];
  }
  const dx: number[] = [];
  for (let i = period; i < n; i++) {
    if (i > period) {
      trS = trS - trS / period + tr[i];
      pS = pS - pS / period + plusDM[i];
      mS = mS - mS / period + minusDM[i];
    }
    const pdi = trS ? (100 * pS) / trS : 0;
    const mdi = trS ? (100 * mS) / trS : 0;
    dx.push(pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi));
    const k = dx.length - 1;
    if (k === period - 1) out[i] = avg(dx);
    else if (k >= period) out[i] = (out[i - 1] * (period - 1) + dx[k]) / period;
  }
  return out;
}

export interface SwingPoint {
  time: number;
  price: number;
}

/**
 * Đỉnh/đáy fractal: nến cao/thấp nhất trong cửa sổ ±k nến.
 * Đỉnh bằng nhau liên tiếp (rất hay gặp ở giá 1–2 chữ số thập phân) chỉ tính nến đầu tiên.
 */
export function swings(candles: Candle[], k = 2): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let i = k; i < candles.length - k; i++) {
    const win = candles.slice(i - k, i + k + 1);
    const c = candles[i];
    const isHigh = win.every((w, j) => j === k || (j < k ? w.high < c.high : w.high <= c.high));
    const isLow = win.every((w, j) => j === k || (j < k ? w.low > c.low : w.low >= c.low));
    if (isHigh) highs.push({ time: c.time, price: c.high });
    if (isLow) lows.push({ time: c.time, price: c.low });
  }
  return { highs, lows };
}

/** Gộp nến nhỏ thành nến lớn hơn theo mốc thời gian UTC (vd: H1 → H4). */
export function aggregate(candles: Candle[], periodMs: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const bucket = Math.floor(c.time / periodMs) * periodMs;
    const cur = out[out.length - 1];
    if (cur && cur.time === bucket) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    } else {
      out.push({ ...c, time: bucket });
    }
  }
  return out;
}

export function atr(candles: Candle[], period = 14): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length < period) return out;
  const tr = candles.map((c, i) =>
    i === 0
      ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)),
  );
  let a = avg(tr.slice(0, period));
  out[period - 1] = a;
  for (let i = period; i < candles.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}
