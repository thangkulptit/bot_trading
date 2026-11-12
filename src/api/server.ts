import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AIAnalyst } from '../ai/AIAnalyst';
import type { Broker } from '../broker/Broker';
import type { Config } from '../config';
import type { OrderRepository } from '../db/OrderRepository';
import type { PositionMonitor } from '../engine/PositionMonitor';
import type { TradingEngine } from '../engine/TradingEngine';
import { logger } from '../logger';
import type { NewsService } from '../news/NewsService';
import type { RiskManager } from '../risk/RiskManager';
import type { OrderStatus } from '../types';
import { errMsg } from '../utils';

export interface BotContext {
  cfg: Config;
  engine: TradingEngine;
  monitor: PositionMonitor;
  broker: Broker;
  news: NewsService;
  analyst: AIAnalyst;
  risk: RiskManager;
  orders: OrderRepository;
}

const limitParam = (v: unknown, def: number) => Math.min(Math.max(Number(v) || def, 1), 500);

function apiKeyAuth(expected: string) {
  const expectedBuf = Buffer.from(expected);
  return (req: Request, res: Response, next: NextFunction) => {
    const given = Buffer.from(String(req.header('x-api-key') ?? ''));
    if (given.length !== expectedBuf.length || !crypto.timingSafeEqual(given, expectedBuf)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

const SAFE_CONFIG_KEYS = [
  'SYMBOL', 'MODE', 'DATA_SOURCE', 'AI_MODE', 'AI_MODEL', 'AI_MIN_CONFIDENCE', 'RISK_PER_TRADE_PCT',
  'MAX_DAILY_LOSS_PCT', 'MAX_DAILY_PROFIT_PCT', 'MAX_DAILY_TRADES', 'MAX_CONSECUTIVE_LOSSES',
  'MAX_OPEN_POSITIONS', 'MAX_FLOATING_LOSS_PCT', 'MAX_SPREAD', 'MIN_SL', 'MAX_SL', 'MIN_RR', 'TP_RR',
  'MAX_LOT', 'MAX_HOLD_MIN', 'BREAKEVEN_AT_R', 'TRAIL_START_R', 'TRAIL_ATR_MULT', 'SESSION_START_UTC',
  'SESSION_END_UTC', 'NEWS_CURRENCIES', 'NEWS_BLOCK_IMPACTS', 'NEWS_BLOCK_BEFORE_MIN',
  'NEWS_BLOCK_AFTER_MIN', 'NEWS_CLOSE_BEFORE_MIN',
] as const;

export function createServer(bot: BotContext): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use('/api', apiKeyAuth(bot.cfg.API_KEY));

  app.get('/api/status', async (_req, res) => {
    const [account, positions, today] = await Promise.all([
      bot.broker.getAccount(),
      bot.broker.getPositions(),
      bot.orders.todayStats(),
    ]);
    res.json({
      mode: bot.cfg.MODE,
      broker: bot.broker.name,
      symbol: bot.cfg.SYMBOL,
      engine: bot.engine.status,
      monitorError: bot.monitor.lastError,
      account,
      risk: bot.risk.summary(account),
      today,
      openPositions: positions.length,
      news: { ...bot.news.getBlockStatus(), feed: bot.news.info() },
    });
  });

  app.post('/api/bot/start', (_req, res) => {
    bot.engine.start();
    res.json({ running: true });
  });

  app.post('/api/bot/stop', (_req, res) => {
    bot.engine.stop();
    res.json({ running: false });
  });

  /** Kill switch: dừng engine, đóng toàn bộ lệnh, khóa giao dịch đến hết ngày. */
  app.post('/api/bot/kill', async (_req, res) => {
    bot.engine.stop();
    await bot.risk.halt('Kill switch thủ công');
    const closed = await bot.monitor.closeAll('Kill switch thủ công');
    res.json({ running: false, closed });
  });

  /** Vị thế thực tế trên broker (realtime), kèm bản ghi DB tương ứng. */
  app.get('/api/positions', async (_req, res) => {
    const [positions, live] = await Promise.all([bot.broker.getPositions(), bot.orders.findLive()]);
    const byPosition = new Map(live.map((o) => [o.positionId, o]));
    res.json(positions.map((p) => ({ ...p, order: byPosition.get(p.id) ?? null })));
  });

  app.post('/api/positions/:id/close', async (req, res) => {
    await bot.monitor.close(req.params.id, 'Đóng thủ công qua API');
    res.json({ closed: req.params.id });
  });

  /** Lệnh trong DB. ?status=LIVE | CLOSED (bỏ trống = tất cả) */
  app.get('/api/orders', async (req, res) => {
    const raw = String(req.query.status ?? '').toUpperCase();
    const status = raw === 'LIVE' || raw === 'CLOSED' ? (raw as OrderStatus) : undefined;
    res.json(await bot.orders.list(status, limitParam(req.query.limit, 50)));
  });

  app.get('/api/orders/:id', async (req, res) => {
    const order = await bot.orders.findById(Number(req.params.id));
    if (!order) {
      res.status(404).json({ error: 'Không tìm thấy lệnh' });
      return;
    }
    res.json({ ...order, events: await bot.orders.events(order.id) });
  });

  app.get('/api/trades', async (req, res) => {
    const [today, trades] = await Promise.all([
      bot.orders.todayStats(),
      bot.orders.recentClosed(limitParam(req.query.limit, 50)),
    ]);
    res.json({ today, trades });
  });

  app.get('/api/decisions', async (req, res) => {
    res.json(await bot.orders.recentDecisions(limitParam(req.query.limit, 30)));
  });

  app.get('/api/news', (_req, res) => {
    res.json({
      block: bot.news.getBlockStatus(),
      today: bot.news.today(),
      upcoming: bot.news.upcoming(Date.now(), 24),
      feed: bot.news.info(),
    });
  });

  app.get('/api/news/briefing', async (req, res) => {
    if (!bot.analyst.enabled) {
      res.status(400).json({ error: 'AI chưa cấu hình' });
      return;
    }
    res.json(await bot.analyst.getBriefing(req.query.refresh === '1'));
  });

  app.post('/api/news/refresh', async (_req, res) => {
    await bot.news.refresh();
    res.json(bot.news.info());
  });

  /** Chạy toàn bộ pipeline phân tích + hỏi AI nhưng KHÔNG vào lệnh. */
  app.post('/api/analyze', async (_req, res) => {
    res.json(await bot.engine.analyzeOnly());
  });

  app.get('/api/logs', (req, res) => {
    res.json(logger.recent(Number(req.query.limit) || 100));
  });

  app.get('/api/config', (_req, res) => {
    res.json(Object.fromEntries(SAFE_CONFIG_KEYS.map((k) => [k, bot.cfg[k]])));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('API lỗi', err);
    res.status(500).json({ error: errMsg(err) });
  });

  return app;
}
