import path from 'node:path';
import type { Config } from '../config';
import { logger } from '../logger';
import type { NewsEvent, NewsImpact } from '../types';
import { errMsg, fetchJson, readJsonFile, utcDay, writeJsonFile } from '../utils';

interface FFEvent {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast?: string;
  previous?: string;
}

interface NewsCache {
  fetchedAt: number;
  events: NewsEvent[];
}

export interface NewsBlockStatus {
  blocked: boolean;
  reason?: string;
  event?: NewsEvent;
}

const MIN = 60_000;
const STALE_AFTER_MS = 26 * 60 * MIN;
const IMPACTS: NewsImpact[] = ['High', 'Medium', 'Low', 'Holiday'];

/** Lịch kinh tế từ ForexFactory (feed JSON miễn phí, giới hạn tần suất gọi — đừng refresh dày). */
export class NewsService {
  private events: NewsEvent[] = [];
  private fetchedAt = 0;
  private lastError: string | null = null;
  private timer?: NodeJS.Timeout;
  private readonly cacheFile: string;

  constructor(private cfg: Config) {
    this.cacheFile = path.join(cfg.DATA_DIR, 'news-cache.json');
  }

  async init(): Promise<void> {
    const cache = await readJsonFile<NewsCache>(this.cacheFile, { fetchedAt: 0, events: [] });
    this.events = cache.events;
    this.fetchedAt = cache.fetchedAt;
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.cfg.NEWS_REFRESH_MIN * MIN);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    try {
      const raw = await fetchJson<FFEvent[]>(this.cfg.NEWS_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      this.events = raw
        .map((e) => ({
          title: e.title,
          currency: e.country,
          time: Date.parse(e.date),
          impact: (IMPACTS.includes(e.impact as NewsImpact) ? e.impact : 'Low') as NewsImpact,
          forecast: e.forecast || undefined,
          previous: e.previous || undefined,
        }))
        .filter((e) => Number.isFinite(e.time))
        .sort((a, b) => a.time - b.time);
      this.fetchedAt = Date.now();
      this.lastError = null;
      await writeJsonFile(this.cacheFile, { fetchedAt: this.fetchedAt, events: this.events } satisfies NewsCache);
      logger.info(`Đã cập nhật lịch tin: ${this.events.length} sự kiện`);
    } catch (e) {
      this.lastError = errMsg(e);
      logger.warn('Không tải được lịch tin, dùng cache', this.lastError);
    }
  }

  private isWatched(e: NewsEvent): boolean {
    return this.cfg.NEWS_CURRENCIES.includes(e.currency);
  }

  private isBlocking(e: NewsEvent): boolean {
    return this.isWatched(e) && this.cfg.NEWS_BLOCK_IMPACTS.includes(e.impact);
  }

  getBlockStatus(now = Date.now()): NewsBlockStatus {
    if (this.cfg.NEWS_FAILSAFE_BLOCK && (!this.events.length || now - this.fetchedAt > STALE_AFTER_MS)) {
      return { blocked: true, reason: 'Không có dữ liệu lịch tin mới (fail-safe: không vào lệnh)' };
    }
    const before = this.cfg.NEWS_BLOCK_BEFORE_MIN * MIN;
    const after = this.cfg.NEWS_BLOCK_AFTER_MIN * MIN;
    const event = this.events.find((e) => this.isBlocking(e) && now >= e.time - before && now <= e.time + after);
    if (!event) return { blocked: false };
    const mins = Math.round((event.time - now) / MIN);
    const when = mins >= 0 ? `còn ${mins} phút` : `đã ra ${-mins} phút`;
    return { blocked: true, event, reason: `Vùng tin ${event.impact}: ${event.currency} ${event.title} (${when})` };
  }

  /** Tin mạnh sắp ra trong NEWS_CLOSE_BEFORE_MIN phút → nên đóng hết lệnh đang mở. */
  eventRequiringFlat(now = Date.now()): NewsEvent | undefined {
    if (this.cfg.NEWS_CLOSE_BEFORE_MIN <= 0) return undefined;
    const window = this.cfg.NEWS_CLOSE_BEFORE_MIN * MIN;
    return this.events.find((e) => this.isBlocking(e) && e.time > now && e.time - now <= window);
  }

  upcoming(now = Date.now(), hours = 6): NewsEvent[] {
    return this.events.filter(
      (e) => this.isWatched(e) && e.impact !== 'Low' && e.time >= now && e.time <= now + hours * 60 * MIN,
    );
  }

  recent(now = Date.now(), hours = 2): NewsEvent[] {
    return this.events.filter(
      (e) => this.isWatched(e) && e.impact !== 'Low' && e.time < now && e.time >= now - hours * 60 * MIN,
    );
  }

  today(now = Date.now()): NewsEvent[] {
    const day = utcDay(now);
    return this.events.filter((e) => this.isWatched(e) && utcDay(e.time) === day);
  }

  info() {
    return { fetchedAt: this.fetchedAt || null, totalEvents: this.events.length, lastError: this.lastError };
  }
}
