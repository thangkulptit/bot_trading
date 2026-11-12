import type { Config } from '../config';
import { adx, atr, ema, rsi, swings } from '../indicators';
import type { Candle, MarketSnapshot, SignalCandidate } from '../types';
import { last, round, utcDay } from '../utils';

export type Bias = 'up' | 'down' | 'range';
export type TfKey = 'h4' | 'h1' | 'm15' | 'm5' | 'm1';

export interface Check {
  id: string;
  label: string;
  pass: boolean;
  /** hard = bắt buộc đạt; soft = cộng điểm hợp lưu. */
  hard: boolean;
  /** env = điều kiện thị trường chung; setup = điều kiện của điểm vào cụ thể. */
  group: 'env' | 'setup';
  detail: string;
}

export interface TfView {
  trend: Bias;
  close: number;
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number | null;
  rsi: number;
  atr: number;
  adx?: number;
  structure?: Bias;
}

export interface KeyLevel {
  price: number;
  kind: string;
}

export interface StrategyResult {
  bias: Bias;
  atrM5: number;
  candidate: SignalCandidate | null;
  checks: Check[];
  softScore: { passed: number; total: number; required: number };
  timeframes: Partial<Record<TfKey, TfView>>;
  levels: KeyLevel[];
  notes: string[];
}

const MIN = 60_000;

function trendOf(close: number, fast: number, slow: number): Bias {
  if (!Number.isFinite(fast) || !Number.isFinite(slow)) return 'range';
  if (close > fast && fast > slow) return 'up';
  if (close < fast && fast < slow) return 'down';
  return 'range';
}

/** Cấu trúc thị trường từ 2 đỉnh/đáy swing gần nhất: HH+HL = tăng, LH+LL = giảm. */
function structureOf(candles: Candle[]): Bias {
  const { highs, lows } = swings(candles.slice(-120), 2);
  if (highs.length < 2 || lows.length < 2) return 'range';
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  if (h2.price > h1.price && l2.price > l1.price) return 'up';
  if (h2.price < h1.price && l2.price < l1.price) return 'down';
  return 'range';
}

/** fast/slow = chu kỳ EMA dùng xác định xu hướng của khung đó. */
function viewOf(candles: Candle[], fast: number, slow: number): TfView {
  const closes = candles.map((c) => c.close);
  const e = (p: number) => last(ema(closes, p));
  const close = last(closes);
  const ema200 = e(200);
  return {
    trend: trendOf(close, e(fast), e(slow)),
    close,
    ema9: e(9),
    ema21: e(21),
    ema50: e(50),
    ema200: Number.isFinite(ema200) ? ema200 : null,
    rsi: last(rsi(closes, 14)),
    atr: last(atr(candles, 14)),
  };
}

/**
 * Scalping XAUUSD đa khung thời gian, ưu tiên an toàn:
 *  H4  — định hướng lớn: không được ngược hướng giao dịch.
 *  H1  — xu hướng chính (giá/EMA50/EMA200) + cấu trúc đỉnh đáy.
 *  M15 — xác nhận xu hướng, ADX đủ mạnh, giá chưa chạy xa EMA21.
 *  M5  — điểm vào: hồi về EMA21 rồi có nến xác nhận tiếp diễn.
 *  M1  — timing: nến M1 gần nhất cùng hướng.
 * Mọi điều kiện hard phải đạt và đủ MIN_SOFT_CHECKS điều kiện soft thì mới có tín hiệu.
 * Chỉ dùng nến đã đóng (bỏ nến cuối đang chạy).
 */
export class ScalpStrategy {
  constructor(private cfg: Config) {}

  evaluate(snap: MarketSnapshot, now = Date.now()): StrategyResult {
    const cfg = this.cfg;
    const closed = (c: Candle[]) => c.slice(0, -1);
    const [h4, h1, m15, m5, m1] = [snap.h4, snap.h1, snap.m15, snap.m5, snap.m1].map(closed);
    const checks: Check[] = [];
    const notes: string[] = [];
    const result: StrategyResult = {
      bias: 'range',
      atrM5: NaN,
      candidate: null,
      checks,
      softScore: { passed: 0, total: 0, required: cfg.MIN_SOFT_CHECKS },
      timeframes: {},
      levels: [],
      notes,
    };
    const add = (id: string, label: string, pass: boolean, hard: boolean, group: Check['group'], detail: string) =>
      checks.push({ id, label, pass, hard, group, detail });

    if (h4.length < 60 || h1.length < 210 || m15.length < 210 || m5.length < 60 || m1.length < 30) {
      notes.push('Chưa đủ dữ liệu nến đa khung');
      return result;
    }

    // ===== Điều kiện thị trường (env) =====
    const delaySec = Math.round((now - (last(snap.m1).time + MIN)) / 1000);
    add('fresh', 'Dữ liệu giá realtime', delaySec <= cfg.MAX_DATA_DELAY_SEC, true, 'env', `trễ ~${Math.max(delaySec, 0)}s`);

    const vH4 = viewOf(h4, 21, 50);
    const vH1 = { ...viewOf(h1, 50, 200), structure: structureOf(h1) };
    const vM15 = { ...viewOf(m15, 50, 200), adx: last(adx(m15, 14)) };
    const vM5 = viewOf(m5, 9, 21);
    const vM1 = viewOf(m1, 9, 21);
    result.timeframes = { h4: vH4, h1: vH1, m15: vM15, m5: vM5, m1: vM1 };
    result.atrM5 = vM5.atr;

    const bias: Bias = vH1.trend !== 'range' && vH1.trend === vM15.trend ? vH1.trend : 'range';
    result.bias = bias;
    const dir = bias === 'up' ? 1 : -1;
    const opposite: Bias = bias === 'up' ? 'down' : 'up';
    const entry = dir === 1 ? snap.quote.ask : snap.quote.bid;

    add('align', 'H1 và M15 cùng xu hướng', bias !== 'range', true, 'env', `H1 ${vH1.trend}, M15 ${vM15.trend}`);
    add('h4', 'H4 không ngược hướng', bias !== 'range' && vH4.trend !== opposite, true, 'env', `H4 ${vH4.trend}`);
    add('adx', `ADX M15 ≥ ${cfg.ADX_MIN}`, vM15.adx >= cfg.ADX_MIN, true, 'env', `ADX ${round(vM15.adx)}`);
    add(
      'atr',
      'Biến động M5 trong vùng an toàn',
      vM5.atr >= cfg.MIN_ATR_M5 && vM5.atr <= cfg.MAX_ATR_M5,
      true,
      'env',
      `ATR M5 ${round(vM5.atr)} (cho phép ${cfg.MIN_ATR_M5}–${cfg.MAX_ATR_M5})`,
    );
    const lastM5 = last(m5);
    const lastM1 = last(m1);
    const spike =
      lastM5.high - lastM5.low > cfg.SPIKE_ATR_MULT * vM5.atr || lastM1.high - lastM1.low > cfg.SPIKE_ATR_MULT * vM1.atr;
    add('spike', 'Không có nến đột biến', !spike, true, 'env', `nến M5 gần nhất ${round(lastM5.high - lastM5.low)}`);
    add(
      'h1_rsi',
      'RSI H1 chưa quá mua/quá bán',
      bias === 'range' || (dir === 1 ? vH1.rsi < 75 : vH1.rsi > 25),
      true,
      'env',
      `RSI H1 ${round(vH1.rsi)}`,
    );
    const ext = Math.abs(entry - vM15.ema21) / vM15.atr;
    add(
      'extension',
      'Giá chưa chạy xa EMA21 M15',
      ext <= cfg.MAX_EXTENSION_ATR_M15,
      true,
      'env',
      `cách ${round(ext)}×ATR M15`,
    );

    result.levels = this.keyLevels(snap.h1, h1, now);

    if (bias === 'range') {
      notes.push('H1/M15 chưa đồng thuận xu hướng — đứng ngoài');
      return result;
    }

    // ===== Điểm vào (setup) =====
    const c5 = m5.map((c) => c.close);
    const e9 = ema(c5, 9);
    const e21 = ema(c5, 21);
    const r5 = rsi(c5, 14);
    const i = m5.length - 1;
    const a5 = vM5.atr;

    const pulledBack = [i - 3, i - 2, i - 1].some((j) =>
      dir === 1 ? m5[j].low <= e21[j] + 0.2 * a5 : m5[j].high >= e21[j] - 0.2 * a5,
    );
    add('m5_pullback', 'M5 hồi về vùng EMA21', pulledBack, true, 'setup', '3 nến gần nhất');
    const resumed =
      (dir === 1 ? e9[i] > e21[i] : e9[i] < e21[i]) &&
      (dir === 1 ? lastM5.close > lastM5.open && lastM5.close > e9[i] : lastM5.close < lastM5.open && lastM5.close < e9[i]);
    add('m5_trigger', 'Nến M5 xác nhận tiếp diễn', resumed, true, 'setup', `đóng ${round(lastM5.close)}, EMA9 ${round(e9[i])}`);
    const rsiOk = dir === 1 ? r5[i] >= 45 && r5[i] <= 70 : r5[i] >= 30 && r5[i] <= 55;
    add('m5_rsi', 'RSI M5 trong vùng động lượng', rsiOk, true, 'setup', `RSI M5 ${round(r5[i])}`);
    const m1Ok =
      dir === 1
        ? lastM1.close > lastM1.open && lastM1.close > vM1.ema9
        : lastM1.close < lastM1.open && lastM1.close < vM1.ema9;
    add('m1_timing', 'Nến M1 cùng hướng (timing)', m1Ok, true, 'setup', `M1 đóng ${round(lastM1.close)}`);

    const recent = m5.slice(-6);
    const structure =
      dir === 1 ? Math.min(...recent.map((c) => c.low)) - 0.2 * a5 : Math.max(...recent.map((c) => c.high)) + 0.2 * a5;
    const dist = Math.max((entry - structure) * dir, cfg.MIN_SL);
    add('sl', 'SL theo cấu trúc trong giới hạn', dist <= cfg.MAX_SL, true, 'setup', `SL ${round(dist)} (tối đa ${cfg.MAX_SL})`);

    const spread = snap.quote.ask - snap.quote.bid;
    add(
      'spread',
      'Spread nhỏ so với SL',
      spread <= cfg.MAX_SPREAD_SL_RATIO * dist,
      true,
      'setup',
      `spread ${round(spread)} = ${round((spread / dist) * 100)}% SL`,
    );

    const tpDist = dist * cfg.TP_RR;
    const blocking = result.levels
      .filter((l) => (l.price - entry) * dir > 0.1)
      .sort((a, b) => (a.price - entry) * dir - (b.price - entry) * dir)[0];
    const room = blocking ? (blocking.price - entry) * dir : Infinity;
    add(
      'room',
      'Đủ khoảng trống tới vùng cản',
      room >= tpDist,
      true,
      'setup',
      blocking ? `${blocking.kind} ${round(blocking.price)} cách ${round(room)}, TP cần ${round(tpDist)}` : 'không có vùng cản gần',
    );

    // ===== Hợp lưu (soft) =====
    add('h4_aligned', 'H4 cùng xu hướng', vH4.trend === bias, false, 'setup', `H4 ${vH4.trend}`);
    add('h1_structure', 'Cấu trúc H1 xác nhận (HH/HL hoặc LH/LL)', vH1.structure === bias, false, 'setup', `H1 ${vH1.structure}`);
    const nextRound = dir === 1 ? Math.ceil(entry / 10) * 10 : Math.floor(entry / 10) * 10;
    const roundRoom = (nextRound - entry) * dir;
    add(
      'round',
      'Không vướng số tròn $10 sát điểm vào',
      roundRoom <= 0.1 || roundRoom >= tpDist * 0.6,
      false,
      'setup',
      `${nextRound} cách ${round(roundRoom)}`,
    );
    const r15 = vM15.rsi;
    add(
      'm15_rsi',
      'RSI M15 lành mạnh',
      dir === 1 ? r15 >= 45 && r15 <= 68 : r15 >= 32 && r15 <= 55,
      false,
      'setup',
      `RSI M15 ${round(r15)}`,
    );

    const soft = checks.filter((c) => !c.hard);
    result.softScore = { passed: soft.filter((c) => c.pass).length, total: soft.length, required: cfg.MIN_SOFT_CHECKS };
    const failedHard = checks.filter((c) => c.hard && !c.pass);
    if (failedHard.length) {
      notes.push(...failedHard.map((c) => `✗ ${c.label}: ${c.detail}`));
      return result;
    }
    if (result.softScore.passed < cfg.MIN_SOFT_CHECKS) {
      notes.push(`Hợp lưu yếu: ${result.softScore.passed}/${result.softScore.total} (cần ${cfg.MIN_SOFT_CHECKS})`);
      return result;
    }

    const d = cfg.PRICE_DIGITS;
    result.candidate = {
      side: dir === 1 ? 'BUY' : 'SELL',
      entry: round(entry, d),
      stopLoss: round(entry - dir * dist, d),
      takeProfit: round(entry + dir * tpDist, d),
      candleTime: lastM5.time,
      reasons: [
        `H4 ${vH4.trend} / H1 ${vH1.trend} (cấu trúc ${vH1.structure}) / M15 ${vM15.trend}, ADX ${round(vM15.adx)}`,
        `M5 hồi về EMA21 + nến xác nhận, RSI M5 ${round(r5[i])}; M1 cùng hướng`,
        `SL ${round(dist)}, TP ${round(tpDist)}, khoảng trống ${room === Infinity ? '∞' : round(room)}; hợp lưu ${result.softScore.passed}/${result.softScore.total}`,
      ],
    };
    return result;
  }

  /** Vùng cản/hỗ trợ: đỉnh đáy swing H1 (3 ngày), đỉnh/đáy hôm qua và hôm nay. */
  private keyLevels(h1All: Candle[], h1Closed: Candle[], now: number): KeyLevel[] {
    const levels: KeyLevel[] = [];
    const { highs, lows } = swings(h1Closed.slice(-72), 2);
    highs.forEach((s) => levels.push({ price: s.price, kind: 'Đỉnh swing H1' }));
    lows.forEach((s) => levels.push({ price: s.price, kind: 'Đáy swing H1' }));

    const today = utcDay(now);
    const prevDay = last([...new Set(h1All.map((c) => utcDay(c.time)))].filter((d) => d < today));
    const byDay = (day: string) => h1All.filter((c) => utcDay(c.time) === day);
    const prev = byDay(prevDay);
    const cur = byDay(today);
    if (prev.length) {
      levels.push({ price: Math.max(...prev.map((c) => c.high)), kind: 'Đỉnh hôm qua' });
      levels.push({ price: Math.min(...prev.map((c) => c.low)), kind: 'Đáy hôm qua' });
    }
    if (cur.length > 1) {
      levels.push({ price: Math.max(...cur.map((c) => c.high)), kind: 'Đỉnh hôm nay' });
      levels.push({ price: Math.min(...cur.map((c) => c.low)), kind: 'Đáy hôm nay' });
    }
    return levels.map((l) => ({ ...l, price: round(l.price) }));
  }
}
