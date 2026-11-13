type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  time: string;
  level: Level;
  msg: string;
  meta?: unknown;
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BUFFER = 500;
const buffer: LogEntry[] = [];
const minLevel = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

// Màu ANSI: tắt khi ghi ra file/pipe hoặc khi đặt NO_COLOR; FORCE_COLOR (ưu tiên hơn NO_COLOR) để ép bật
const forceColor = process.env.FORCE_COLOR;
const useColor =
  forceColor !== undefined && forceColor !== '0'
    ? true
    : !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
const paint =
  (code: string) =>
  (s: string): string =>
    useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

const c = {
  dim: paint('2'),
  gray: paint('90'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  bold: paint('1'),
  boldRed: paint('1;31'),
  boldGreen: paint('1;32'),
};

const BADGE: Record<Level, (s: string) => string> = {
  debug: c.gray,
  info: c.cyan,
  warn: c.yellow,
  error: c.boldRed,
};

const MESSAGE: Record<Level, (s: string) => string> = {
  debug: c.gray,
  info: (s) => s,
  warn: c.yellow,
  error: c.red,
};

/** Tô nổi các sự kiện giao dịch trong log info. */
const HIGHLIGHTS: Array<[RegExp, (s: string) => string]> = [
  [/^MỞ /, c.boldGreen],
  [/^AI:/, c.magenta],
  [/^Dời SL/, c.blue],
  [/^Engine (START|STOP)/, c.bold],
  [/\bBUY\b/g, c.green],
  [/\bSELL\b/g, c.red],
  [/\+\d+(\.\d+)? USD/g, c.green],
  [/(?<![\w.])-\d+(\.\d+)? USD/g, c.red],
];

function highlight(msg: string): string {
  if (!useColor) return msg;
  return HIGHLIGHTS.reduce((s, [re, fn]) => s.replace(re, (m) => fn(m)), msg);
}

function normalize(meta: unknown): unknown {
  return meta instanceof Error ? meta.message : meta;
}

function log(level: Level, msg: string, meta?: unknown): void {
  const entry: LogEntry = { time: new Date().toISOString(), level, msg, meta: normalize(meta) };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  if (LEVELS[level] < minLevel) return;

  const time = c.gray(entry.time.replace('T', ' ').slice(0, 23));
  const badge = BADGE[level](level.toUpperCase().padEnd(5));
  const text = level === 'info' ? highlight(msg) : MESSAGE[level](msg);
  const line = `${time} ${badge} ${text}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (entry.meta === undefined) out(line);
  else out(line, c.dim(typeof entry.meta === 'object' ? JSON.stringify(entry.meta) : String(entry.meta)));
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log('debug', msg, meta),
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
  recent: (n = 100): LogEntry[] => buffer.slice(-n),
};
