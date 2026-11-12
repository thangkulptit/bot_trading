/**
 * Schema được áp dụng tự động khi khởi động (idempotent).
 * Mỗi lệnh bot quản lý là một dòng trong `orders`; status LIVE = đang mở trên broker, CLOSED = đã đóng.
 */
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS orders (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    broker           VARCHAR(32)  NOT NULL COMMENT 'paper | metaapi-live',
    position_id      VARCHAR(64)  NOT NULL COMMENT 'ID vị thế trên broker',
    symbol           VARCHAR(32)  NOT NULL,
    side             ENUM('BUY','SELL') NOT NULL,
    status           ENUM('LIVE','CLOSED') NOT NULL DEFAULT 'LIVE',
    volume           DECIMAL(10,2) NOT NULL,
    entry_price      DECIMAL(12,3) NOT NULL,
    initial_sl       DECIMAL(12,3) NULL COMMENT 'SL lúc vào lệnh, dùng tính R',
    current_sl       DECIMAL(12,3) NULL,
    take_profit      DECIMAL(12,3) NULL,
    current_price    DECIMAL(12,3) NULL,
    floating_profit  DECIMAL(12,2) NULL,
    close_price      DECIMAL(12,3) NULL,
    profit           DECIMAL(12,2) NULL COMMENT 'Lãi/lỗ thực nhận khi CLOSED',
    r_multiple       DECIMAL(8,2)  NULL,
    close_reason     VARCHAR(255)  NULL,
    source           VARCHAR(32)  NOT NULL COMMENT 'rules | rules+ai | ai | external',
    ai_confidence    DECIMAL(4,3) NULL,
    reasoning        TEXT NULL,
    opened_at        DATETIME(3) NOT NULL,
    closed_at        DATETIME(3) NULL,
    updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_broker_position (broker, position_id),
    KEY idx_status (broker, status),
    KEY idx_closed_at (broker, closed_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS order_events (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id    BIGINT UNSIGNED NOT NULL,
    type        VARCHAR(32) NOT NULL COMMENT 'OPENED | EXTERNAL_DETECTED | SL_MOVED | SL_ENFORCED | CLOSE_REQUESTED | CLOSED',
    message     VARCHAR(500) NOT NULL,
    data        JSON NULL,
    created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_order (order_id, created_at),
    CONSTRAINT fk_events_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS ai_decisions (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    mode        VARCHAR(16) NOT NULL,
    action      ENUM('BUY','SELL','HOLD') NOT NULL,
    confidence  DECIMAL(4,3) NOT NULL,
    stop_loss   DECIMAL(12,3) NULL,
    take_profit DECIMAL(12,3) NULL,
    reasoning   TEXT NULL,
    risk_notes  TEXT NULL,
    candidate   JSON NULL,
    executed    TINYINT(1) NOT NULL DEFAULT 0,
    note        VARCHAR(255) NULL,
    created_at  DATETIME(3) NOT NULL,
    KEY idx_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];
