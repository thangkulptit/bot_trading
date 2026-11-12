import { config } from '../config';
import { logger } from '../logger';
import { connectDatabase } from './db';

connectDatabase(config)
  .then(async (pool) => {
    const [rows] = await pool.query('SHOW TABLES');
    logger.info('Các bảng hiện có', rows);
    await pool.end();
  })
  .catch((e) => {
    logger.error('Migrate thất bại', e);
    process.exit(1);
  });
