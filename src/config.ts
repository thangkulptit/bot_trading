import 'dotenv/config';
import { z } from 'zod';

const blankToUndefined = (v: unknown) => (v === '' ? undefined : v);
const num = (def: number) => z.preprocess(blankToUndefined, z.coerce.number().default(def));
const bool = (def: boolean) =>
  z.preprocess(
    blankToUndefined,
    z
      .enum(['true', 'false', '1', '0'])
      .default(def ? 'true' : 'false')
      .transform((v) => v === 'true' || v === '1'),
  );
const str = (def: string) => z.preprocess(blankToUndefined, z.string().default(def));
const optStr = () => z.preprocess(blankToUndefined, z.string().optional());
const list = (def: string) =>
  str(def).transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z
  .object({
    PORT: num(3000),
    API_KEY: z.string().min(8, 'API_KEY phải có ít nhất 8 ký tự'),
    LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(['debug', 'info', 'warn', 'error']).default('info')),
    DATA_DIR: str('./data'),

    DB_HOST: str('127.0.0.1'),
    DB_PORT: num(3306),
    DB_USER: str('root'),
    DB_PASSWORD: str(''),
    DB_NAME: z.preprocess(blankToUndefined, z.string().regex(/^\w+$/, 'DB_NAME chỉ gồm chữ, số, _').default('xau_bot')),
    DB_SOCKET: optStr(),
    DB_CONNECTION_LIMIT: num(5),
    DB_AUTO_CREATE: bool(true),

    SYMBOL: str('XAUUSD'),
    MODE: z.preprocess(blankToUndefined, z.enum(['paper', 'live']).default('paper')),
    LIVE_CONFIRM: optStr(),
    DATA_SOURCE: z.preprocess(blankToUndefined, z.enum(['mt5', 'yahoo']).default('mt5')),
    YAHOO_SYMBOL: str('GC=F'),
    MAX_DATA_DELAY_SEC: num(120),
    AUTO_START: bool(false),
    LOOP_INTERVAL_SEC: num(20),
    MONITOR_INTERVAL_SEC: num(5),
    PRICE_DIGITS: num(2),

    MT5_BRIDGE_URL: str('http://127.0.0.1:8765'),
    MT5_BRIDGE_TOKEN: optStr(),

    PAPER_START_BALANCE: num(10000),
    PAPER_SPREAD: num(0.25),

    AI_BASE_URL: str('https://api.openai.com/v1'),
    AI_API_KEY: optStr(),
    AI_MODEL: str('gpt-4o-mini'),
    AI_MODE: z.preprocess(blankToUndefined, z.enum(['confirm', 'autonomous', 'off']).default('confirm')),
    AI_JSON_MODE: bool(true),
    AI_MIN_CONFIDENCE: num(0.65),
    AI_MIN_INTERVAL_SEC: num(60),
    AI_TIMEOUT_MS: num(30000),
    AI_CONTEXT_MAX_CHARS: num(12000),

    RISK_PER_TRADE_PCT: num(0.5),
    MAX_DAILY_LOSS_PCT: num(2),
    MAX_DAILY_PROFIT_PCT: num(3),
    MAX_DAILY_TRADES: num(8),
    MAX_CONSECUTIVE_LOSSES: num(3),
    COOLDOWN_AFTER_LOSS_STREAK_MIN: num(60),
    MAX_OPEN_POSITIONS: num(1),
    MAX_FLOATING_LOSS_PCT: num(1),
    MAX_SPREAD: num(0.5),
    MIN_SL: num(1.5),
    MAX_SL: num(6),
    MIN_RR: num(1.2),
    TP_RR: num(1.5),
    CONTRACT_SIZE: num(100),
    MIN_LOT: num(0.01),
    LOT_STEP: num(0.01),
    MAX_LOT: num(1),
    MAX_HOLD_MIN: num(45),
    BREAKEVEN_AT_R: num(1),
    BREAKEVEN_OFFSET: num(0.1),
    TRAIL_START_R: num(1.3),
    TRAIL_ATR_MULT: num(1),
    MIN_STOP_DISTANCE: num(0.5),

    ADX_MIN: num(20),
    MIN_ATR_M5: num(0.8),
    MAX_ATR_M5: num(6),
    SPIKE_ATR_MULT: num(2.5),
    MAX_EXTENSION_ATR_M15: num(1.5),
    MAX_SPREAD_SL_RATIO: num(0.12),
    MIN_SOFT_CHECKS: num(2),
    MAX_ENTRY_DRIFT_R: num(0.25),

    SESSION_START_UTC: num(7),
    SESSION_END_UTC: num(20),
    FRIDAY_CUTOFF_UTC: num(18),

    NEWS_URL: str('https://nfs.faireconomy.media/ff_calendar_thisweek.json'),
    NEWS_CURRENCIES: list('USD'),
    NEWS_BLOCK_IMPACTS: list('High'),
    NEWS_BLOCK_BEFORE_MIN: num(30),
    NEWS_BLOCK_AFTER_MIN: num(30),
    NEWS_CLOSE_BEFORE_MIN: num(5),
    NEWS_REFRESH_MIN: num(60),
    NEWS_FAILSAFE_BLOCK: bool(true),
  })
  .superRefine((c, ctx) => {
    const needBridge = c.MODE === 'live' || c.DATA_SOURCE === 'mt5';
    if (needBridge && !c.MT5_BRIDGE_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Cần MT5_BRIDGE_TOKEN (trùng BRIDGE_TOKEN của bridge Python) khi MODE=live hoặc DATA_SOURCE=mt5',
      });
    }
    if (c.MODE === 'live' && c.DATA_SOURCE !== 'mt5') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MODE=live phải phân tích trên chart của chính tài khoản MT5 (DATA_SOURCE=mt5)',
      });
    }
    if (c.MODE === 'live' && c.LIVE_CONFIRM !== 'I_UNDERSTAND_THE_RISK') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MODE=live yêu cầu LIVE_CONFIRM=I_UNDERSTAND_THE_RISK',
      });
    }
    if (c.AI_MODE !== 'off' && !c.AI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AI_MODE=confirm/autonomous cần AI_API_KEY (hoặc đặt AI_MODE=off để chạy thuần quy tắc)',
      });
    }
    if (c.MIN_SL >= c.MAX_SL) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MIN_SL phải nhỏ hơn MAX_SL' });
    }
  });

export type Config = z.infer<typeof schema>;

function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Cấu hình .env không hợp lệ:');
    for (const issue of parsed.error.issues) {
      console.error(` - ${issue.path.join('.') || '(chung)'}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
