import type { Config } from '../config';
import type { DecisionLog } from '../db/OrderRepository';
import { atr, ema, rsi } from '../indicators';
import type { RiskSummary } from '../risk/RiskManager';
import type { StrategyResult } from '../strategy/ScalpStrategy';
import type { AccountInfo, Candle, MarketSnapshot, NewsEvent, Position, SignalCandidate, TradeOrder } from '../types';
import { hhmm, last, round } from '../utils';

export interface ContextInput {
  now: number;
  snap: MarketSnapshot;
  account: AccountInfo;
  positions: Position[];
  risk: RiskSummary;
  strategy: StrategyResult;
  candidate: SignalCandidate | null;
  news: { upcoming: NewsEvent[]; recent: NewsEvent[]; briefing?: string };
  recentTrades: TradeOrder[];
  recentDecisions: DecisionLog[];
}

const val = (arr: number[]): number | null => {
  const x = last(arr);
  return Number.isFinite(x) ? round(x) : null;
};

/**
 * Nén toàn bộ trạng thái thị trường/tài khoản thành JSON gọn cho LLM.
 * Nếu vượt AI_CONTEXT_MAX_CHARS sẽ giảm dần độ chi tiết (số nến, lịch sử) thay vì cắt ngang.
 */
export class ContextBuilder {
  constructor(private cfg: Config) {}

  build(input: ContextInput): string {
    const levels: Array<[number, boolean]> = [
      [12, true],
      [8, true],
      [5, true],
      [3, false],
      [0, false],
    ];
    let json = '';
    for (const [candles, withHistory] of levels) {
      json = JSON.stringify(this.compose(input, candles, withHistory));
      if (json.length <= this.cfg.AI_CONTEXT_MAX_CHARS) return json;
    }
    return json;
  }

  private tf(candles: Candle[], n: number) {
    const closed = candles.slice(0, -1);
    if (!closed.length) return null;
    const closes = closed.map((c) => c.close);
    const recent20 = closed.slice(-20);
    return {
      close: round(last(closes)),
      ema9: val(ema(closes, 9)),
      ema21: val(ema(closes, 21)),
      ema50: val(ema(closes, 50)),
      ema200: val(ema(closes, 200)),
      rsi14: val(rsi(closes, 14)),
      atr14: val(atr(closed, 14)),
      high_20: round(Math.max(...recent20.map((c) => c.high))),
      low_20: round(Math.min(...recent20.map((c) => c.low))),
      ...(n > 0 && {
        candles_t_o_h_l_c: closed
          .slice(-n)
          .map((c) => [hhmm(c.time), round(c.open), round(c.high), round(c.low), round(c.close)]),
      }),
    };
  }

  /** 3 vùng cản gần nhất phía trên và 3 vùng hỗ trợ gần nhất phía dưới giá. */
  private levels(i: ContextInput, price: number) {
    const near = (above: boolean) =>
      i.strategy.levels
        .filter((l) => (above ? l.price > price : l.price < price))
        .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
        .slice(0, 3)
        .map((l) => ({ price: l.price, kind: l.kind, distance: round(Math.abs(l.price - price)) }));
    return {
      resistance: near(true),
      support: near(false),
      round_above: Math.ceil(price / 10) * 10,
      round_below: Math.floor(price / 10) * 10,
    };
  }

  private news(e: NewsEvent, now: number) {
    return {
      time: hhmm(e.time),
      minutes_from_now: Math.round((e.time - now) / 60_000),
      impact: e.impact,
      title: `${e.currency} ${e.title}`,
      forecast: e.forecast,
      previous: e.previous,
    };
  }

  private compose(i: ContextInput, nCandles: number, withHistory: boolean) {
    const { snap, now } = i;
    const mid = (snap.quote.bid + snap.quote.ask) / 2;
    return {
      time_utc: new Date(now).toISOString().slice(0, 16),
      symbol: this.cfg.SYMBOL,
      quote: { bid: snap.quote.bid, ask: snap.quote.ask, spread: round(snap.quote.ask - snap.quote.bid) },
      account: {
        balance: round(i.account.balance),
        equity: round(i.account.equity),
        daily_pnl: i.risk.dailyPnl,
        daily_pnl_pct: i.risk.dailyPnlPct,
        trades_today: i.risk.tradesToday,
        consecutive_losses: i.risk.consecutiveLosses,
      },
      open_positions: i.positions.map((p) => ({
        side: p.side,
        volume: p.volume,
        open: p.openPrice,
        sl: p.stopLoss ?? null,
        tp: p.takeProfit ?? null,
        profit: p.profit,
        minutes_open: Math.round((now - p.openTime) / 60_000),
      })),
      multi_timeframe: {
        bias_h1_m15: i.strategy.bias,
        h4_structure_note: 'H4: trend theo EMA21/EMA50; H1/M15: trend theo EMA50/EMA200; M5/M1: EMA9/EMA21',
        h4: this.tf(snap.h4, Math.min(nCandles, 6)),
        h1: { ...this.tf(snap.h1, Math.min(nCandles, 8)), structure: i.strategy.timeframes.h1?.structure ?? null },
        m15: { ...this.tf(snap.m15, nCandles), adx14: val([i.strategy.timeframes.m15?.adx ?? NaN]) },
        m5: this.tf(snap.m5, nCandles),
        m1: this.tf(snap.m1, Math.min(nCandles, 10)),
      },
      pre_trade_checklist: {
        hard_rule: 'Mọi mục hard phải PASS; soft cần đạt tối thiểu theo soft_score.required',
        items: i.strategy.checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} [${c.hard ? 'hard' : 'soft'}] ${c.label} — ${c.detail}`),
        soft_score: i.strategy.softScore,
      },
      levels: this.levels(i, mid),
      news: {
        upcoming_6h: i.news.upcoming.map((e) => this.news(e, now)),
        released_last_2h: i.news.recent.map((e) => this.news(e, now)),
        daily_briefing: i.news.briefing ?? null,
      },
      candidate_signal: i.candidate,
      hard_limits: { min_sl: this.cfg.MIN_SL, max_sl: this.cfg.MAX_SL, min_rr: this.cfg.MIN_RR },
      ...(withHistory && {
        recent_trades: i.recentTrades.slice(-5).map((t) => ({
          side: t.side,
          profit: t.profit,
          r: t.rMultiple,
          reason: t.closeReason,
          closed: t.closedAt ? hhmm(t.closedAt) : null,
        })),
        recent_ai_decisions: i.recentDecisions.slice(-3).map((d) => ({
          time: hhmm(d.time),
          action: d.decision.action,
          confidence: d.decision.confidence,
          executed: d.executed,
        })),
      }),
    };
  }
}
