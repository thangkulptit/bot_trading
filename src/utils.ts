import fs from 'node:fs/promises';
import path from 'node:path';

export const round = (v: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export const last = <T>(arr: T[]): T => arr[arr.length - 1];

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const utcDay = (t: number = Date.now()): string => new Date(t).toISOString().slice(0, 10);

export const hhmm = (t: number): string => new Date(t).toISOString().slice(11, 16);

export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 15000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

const writeQueues = new Map<string, Promise<void>>();

export function writeJsonFile(file: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const prev = writeQueues.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, json);
      await fs.rename(tmp, file);
    });
  writeQueues.set(file, next);
  return next;
}
