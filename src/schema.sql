-- MT5 Trade Logger Schema

CREATE TABLE IF NOT EXISTS deals (
  ticket BIGINT PRIMARY KEY,
  account_id BIGINT NOT NULL,
  order_ticket BIGINT,
  position_ticket BIGINT,
  symbol VARCHAR(32),
  type VARCHAR(64),
  volume DECIMAL(10,2),
  price DECIMAL(16,5),
  profit DECIMAL(16,2),
  commission DECIMAL(16,2),
  swap DECIMAL(16,2),
  sl DECIMAL(16,5) DEFAULT 0,
  tp DECIMAL(16,5) DEFAULT 0,
  magic_number BIGINT DEFAULT 0,
  comment TEXT,
  deal_time TIMESTAMP,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  raw_data JSONB
);

-- Add SL/TP columns if they don't exist (for existing tables)
DO $$ BEGIN
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS sl DECIMAL(16,5) DEFAULT 0;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS tp DECIMAL(16,5) DEFAULT 0;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS sl DECIMAL(16,5) DEFAULT 0;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS tp DECIMAL(16,5) DEFAULT 0;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS orders (
  ticket BIGINT PRIMARY KEY,
  account_id BIGINT NOT NULL,
  symbol VARCHAR(32),
  type VARCHAR(64),
  volume DECIMAL(10,2),
  price DECIMAL(16,5),
  sl DECIMAL(16,5) DEFAULT 0,
  tp DECIMAL(16,5) DEFAULT 0,
  order_time TIMESTAMP,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  raw_data JSONB
);

CREATE TABLE IF NOT EXISTS account_snapshots (
  id SERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  balance DECIMAL(16,2),
  equity DECIMAL(16,2),
  margin DECIMAL(16,2),
  free_margin DECIMAL(16,2),
  daily_pnl DECIMAL(16,2),
  unrealized_pnl DECIMAL(16,2),
  currency VARCHAR(8),
  snapshot_time TIMESTAMP,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS open_positions (
  ticket BIGINT NOT NULL,
  account_id BIGINT NOT NULL,
  symbol VARCHAR(32),
  type VARCHAR(64),
  volume DECIMAL(10,2),
  price_open DECIMAL(16,5),
  price_current DECIMAL(16,5),
  sl DECIMAL(16,5) DEFAULT 0,
  tp DECIMAL(16,5) DEFAULT 0,
  profit DECIMAL(16,2),
  swap DECIMAL(16,2),
  position_time TIMESTAMP,
  magic_number BIGINT DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticket, account_id)
);

CREATE INDEX IF NOT EXISTS idx_positions_account ON open_positions(account_id);

-- Indexes for deals
CREATE INDEX IF NOT EXISTS idx_deals_account_id ON deals(account_id);
CREATE INDEX IF NOT EXISTS idx_deals_deal_time ON deals(deal_time);
CREATE INDEX IF NOT EXISTS idx_deals_symbol ON deals(symbol);

-- Indexes for orders
CREATE INDEX IF NOT EXISTS idx_orders_account_id ON orders(account_id);
CREATE INDEX IF NOT EXISTS idx_orders_order_time ON orders(order_time);

-- Indexes for account_snapshots
CREATE INDEX IF NOT EXISTS idx_snapshots_account_id ON account_snapshots(account_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON account_snapshots(snapshot_time);
CREATE INDEX IF NOT EXISTS idx_snapshots_account_time ON account_snapshots(account_id, snapshot_time DESC);
