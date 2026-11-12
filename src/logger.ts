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

function normalize(meta: unknown): unknown {
  return meta instanceof Error ? meta.message : meta;
}

function log(level: Level, msg: string, meta?: unknown): void {
  const entry: LogEntry = { time: new Date().toISOString(), level, msg, meta: normalize(meta) };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  if (LEVELS[level] < minLevel) return;

  const line = `[${entry.time}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (entry.meta === undefined) out(line);
  else out(line, typeof entry.meta === 'object' ? JSON.stringify(entry.meta) : entry.meta);
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log('debug', msg, meta),
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
  recent: (n = 100): LogEntry[] => buffer.slice(-n),
};
