import { z } from 'zod';
import type { Config } from '../config';
import { logger } from '../logger';
import type { NewsService } from '../news/NewsService';
import type { AIDecision } from '../types';
import { errMsg, utcDay } from '../utils';
import type { AIClient } from './AIClient';
import { BRIEFING_SYSTEM_PROMPT, briefingUserPrompt, traderSystemPrompt, traderUserPrompt } from './prompts';

const optionalPrice = z.preprocess(
  (v) => (v === null || v === '' || v === undefined ? undefined : Number(v)),
  z.number().positive().optional(),
);

const decisionSchema = z.object({
  action: z.preprocess((v) => String(v).toUpperCase(), z.enum(['BUY', 'SELL', 'HOLD'])),
  confidence: z.preprocess((v) => {
    const n = Number(v);
    return n > 1 ? n / 100 : n;
  }, z.number().min(0).max(1)),
  stop_loss: optionalPrice,
  take_profit: optionalPrice,
  reasoning: z.string().default(''),
  risk_notes: z.string().nullish(),
});

const briefingSchema = z.object({
  summary: z.string(),
  gold_bias: z.enum(['bullish', 'bearish', 'neutral', 'mixed']).catch('mixed'),
  volatility: z.enum(['low', 'medium', 'high']).catch('medium'),
  key_events: z
    .array(z.object({ time_utc: z.string(), title: z.string(), why_it_matters: z.string() }))
    .catch([]),
  no_trade_windows_utc: z.array(z.string()).catch([]),
});

export type NewsBriefing = z.infer<typeof briefingSchema> & { day: string; createdAt: number };

export class AIAnalyst {
  private briefing: NewsBriefing | null = null;
  private briefingInFlight: Promise<NewsBriefing | null> | null = null;

  constructor(
    private ai: AIClient,
    private cfg: Config,
    private news: NewsService,
  ) {}

  get enabled(): boolean {
    return this.ai.enabled;
  }

  async decide(context: string): Promise<AIDecision> {
    const raw = await this.ai.chatJSON(traderSystemPrompt(this.cfg), traderUserPrompt(context), decisionSchema);
    return {
      action: raw.action,
      confidence: raw.confidence,
      stopLoss: raw.stop_loss,
      takeProfit: raw.take_profit,
      reasoning: raw.reasoning,
      riskNotes: raw.risk_notes ?? undefined,
    };
  }

  /** Phân tích lịch tin trong ngày bằng AI, cache theo ngày UTC. */
  async getBriefing(force = false): Promise<NewsBriefing | null> {
    const day = utcDay();
    if (!force && this.briefing?.day === day) return this.briefing;
    if (!this.enabled) return null;
    if (this.briefingInFlight) return this.briefingInFlight;

    this.briefingInFlight = (async () => {
      try {
        const data = await this.ai.chatJSON(
          BRIEFING_SYSTEM_PROMPT,
          briefingUserPrompt(day, this.news.today()),
          briefingSchema,
        );
        this.briefing = { ...data, day, createdAt: Date.now() };
        logger.info(`AI briefing ${day}: bias=${data.gold_bias}, volatility=${data.volatility}`);
        return this.briefing;
      } catch (e) {
        logger.warn('Không tạo được AI briefing', errMsg(e));
        return this.briefing;
      } finally {
        this.briefingInFlight = null;
      }
    })();
    return this.briefingInFlight;
  }

  briefingSummary(): string | undefined {
    const b = this.briefing;
    if (!b || b.day !== utcDay()) return undefined;
    const windows = b.no_trade_windows_utc.length ? ` Tránh: ${b.no_trade_windows_utc.join(', ')} UTC.` : '';
    return `[${b.gold_bias}/${b.volatility}] ${b.summary}${windows}`;
  }
}
