import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';
import type { Config } from '../config';
import { logger } from '../logger';
import { SCHEMA } from './schema';

function baseOptions(cfg: Config): PoolOptions {
  return {
    ...(cfg.DB_SOCKET ? { socketPath: cfg.DB_SOCKET } : { host: cfg.DB_HOST, port: cfg.DB_PORT }),
    user: cfg.DB_USER,
    password: cfg.DB_PASSWORD,
    timezone: 'Z',
    decimalNumbers: true,
    charset: 'utf8mb4',
  };
}

/** Kết nối MySQL, tạo database (nếu DB_AUTO_CREATE) và các bảng nếu chưa có. */
export async function connectDatabase(cfg: Config): Promise<Pool> {
  if (cfg.DB_AUTO_CREATE) {
    const conn = await mysql.createConnection(baseOptions(cfg));
    try {
      await conn.query(
        `CREATE DATABASE IF NOT EXISTS \`${cfg.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    } finally {
      await conn.end();
    }
  }

  const pool = mysql.createPool({
    ...baseOptions(cfg),
    database: cfg.DB_NAME,
    connectionLimit: cfg.DB_CONNECTION_LIMIT,
    waitForConnections: true,
  });
  for (const sql of SCHEMA) await pool.query(sql);

  const where = cfg.DB_SOCKET ?? `${cfg.DB_HOST}:${cfg.DB_PORT}`;
  logger.info(`MySQL đã kết nối: ${where}/${cfg.DB_NAME}`);
  return pool;
}
