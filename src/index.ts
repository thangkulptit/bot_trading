import { AIAnalyst } from './ai/AIAnalyst';
import { AIClient } from './ai/AIClient';
import { ContextBuilder } from './ai/ContextBuilder';
import { createServer } from './api/server';
import type { Broker } from './broker/Broker';
import { MetaApiBroker } from './broker/MetaApiBroker';
import { PaperBroker } from './broker/PaperBroker';
import { config as cfg } from './config';
import { connectDatabase } from './db/db';
import { OrderRepository } from './db/OrderRepository';
import { PositionMonitor } from './engine/PositionMonitor';
import { TradingEngine } from './engine/TradingEngine';
import { logger } from './logger';
import type { MarketData } from './market/MarketData';
import { MetaApiClient } from './market/MetaApiClient';
import { MetaApiMarketData } from './market/MetaApiMarketData';
import { YahooMarketData } from './market/YahooMarketData';
import { NewsService } from './news/NewsService';
import { RiskManager } from './risk/RiskManager';
import { ScalpStrategy } from './strategy/ScalpStrategy';

async function main(): Promise<void> {
  const metaApi =
    cfg.METAAPI_TOKEN && cfg.METAAPI_ACCOUNT_ID
      ? new MetaApiClient(cfg.METAAPI_TOKEN, cfg.METAAPI_ACCOUNT_ID, cfg.METAAPI_REGION, cfg.SYMBOL)
      : null;

  const md: MarketData =
    cfg.DATA_SOURCE === 'metaapi' && metaApi ? new MetaApiMarketData(metaApi) : new YahooMarketData(cfg);
  const broker: Broker = cfg.MODE === 'live' && metaApi ? new MetaApiBroker(metaApi) : new PaperBroker(md, cfg);

  const pool = await connectDatabase(cfg);
  const orders = new OrderRepository(pool, broker.name);
  const news = new NewsService(cfg);
  const risk = new RiskManager(cfg);
  const analyst = new AIAnalyst(new AIClient(cfg), cfg, news);

  await Promise.all([broker.init?.(), risk.init()]);
  await news.init();

  const engine = new TradingEngine({
    cfg,
    broker,
    md,
    news,
    analyst,
    risk,
    orders,
    strategy: new ScalpStrategy(cfg),
    context: new ContextBuilder(cfg),
  });
  const monitor = new PositionMonitor({ cfg, broker, news, risk, orders, getAtr: () => engine.lastAtrM5 });
  monitor.start();

  const app = createServer({ cfg, engine, monitor, broker, news, analyst, risk, orders });
  const server = app.listen(cfg.PORT, () => {
    logger.info(
      `XAUUSD bot API tại http://localhost:${cfg.PORT} (mode=${cfg.MODE}, chart=${md.name}, broker=${broker.name}, symbol=${cfg.SYMBOL}, AI=${cfg.AI_MODE})`,
    );
    if (cfg.MODE === 'live') logger.warn('ĐANG CHẠY TÀI KHOẢN THẬT');
    if (cfg.AUTO_START) engine.start();
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} — dừng bot (không tự đóng lệnh đang mở; SL/TP vẫn nằm trên broker)`);
    engine.stop();
    monitor.stop();
    news.stop();
    server.close(() => void pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.error('Khởi động thất bại', e);
  process.exit(1);
});
