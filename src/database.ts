import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DatabaseService {
  private pool: Pool;
  private isConnected: boolean = false;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 20000,
      statement_timeout: 30000,
    });

    this.pool.on('error', (err) => {
      console.error('[Database] Unexpected pool error:', err);
    });
  }

  async connect(): Promise<void> {
    try {
      console.log('[Database] Attempting to connect...');
      const client = await this.pool.connect();
      console.log('[Database] Connected successfully');
      client.release();

      console.log('[Database] Initializing schema...');
      await this.initializeSchema();
      this.isConnected = true;
    } catch (error) {
      console.error('[Database] Connection failed:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  private async initializeSchema(): Promise<void> {
    try {
      const schemaPath = path.join(__dirname, 'schema.sql');
      console.log('[Database] Reading schema from:', schemaPath);

      if (!fs.existsSync(schemaPath)) {
        console.error('[Database] Schema file not found at:', schemaPath);
        throw new Error(`Schema file not found at ${schemaPath}`);
      }

      const schema = fs.readFileSync(schemaPath, 'utf8');
      await this.pool.query(schema);
      console.log('[Database] Schema initialized successfully');
    } catch (error) {
      console.error('[Database] Schema initialization failed:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Parse MT5 EA time format "YYYY.MM.DD HH:MM:SS" to a Date object.
   */
  private parseEATime(timeStr: string): Date {
    if (!timeStr) return new Date();
    // Convert "2024.01.15 14:30:00" to "2024-01-15T14:30:00"
    const isoStr = timeStr.replace(/\./g, '-').replace(' ', 'T');
    const parsed = new Date(isoStr);
    if (isNaN(parsed.getTime())) {
      console.warn(`[Database] Invalid EA time format: "${timeStr}", using current time`);
      return new Date();
    }
    return parsed;
  }

  async storeDeal(payload: any): Promise<void> {
    if (!this.isConnected) return;
    try {
      const dealTime = this.parseEATime(payload.time);
      const query = `
        INSERT INTO deals (ticket, account_id, order_ticket, position_ticket, symbol, type, volume, price, profit, commission, swap, sl, tp, magic_number, comment, entry, deal_time, raw_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (ticket) DO UPDATE SET
          sl = EXCLUDED.sl,
          tp = EXCLUDED.tp,
          entry = EXCLUDED.entry,
          raw_data = EXCLUDED.raw_data
      `;
      const values = [
        payload.ticket,
        payload.account_id,
        payload.order_ticket || null,
        payload.position_ticket || null,
        payload.symbol,
        payload.type,
        payload.volume,
        payload.price,
        payload.profit,
        payload.commission,
        payload.swap,
        payload.sl || 0,
        payload.tp || 0,
        payload.magic_number || 0,
        payload.comment || null,
        payload.entry || null,
        dealTime,
        JSON.stringify(payload),
      ];
      await this.pool.query(query, values);
      console.log(`[Database] Stored deal ticket=${payload.ticket}`);
    } catch (error) {
      console.error('[Database] Failed to store deal:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async storeOrder(payload: any): Promise<void> {
    if (!this.isConnected) return;
    try {
      const orderTime = this.parseEATime(payload.time);
      const query = `
        INSERT INTO orders (ticket, account_id, symbol, type, volume, price, sl, tp, order_time, raw_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (ticket) DO UPDATE SET
          sl = EXCLUDED.sl,
          tp = EXCLUDED.tp,
          raw_data = EXCLUDED.raw_data
      `;
      const values = [
        payload.ticket,
        payload.account_id,
        payload.symbol,
        payload.type,
        payload.volume,
        payload.price,
        payload.sl || 0,
        payload.tp || 0,
        orderTime,
        JSON.stringify(payload),
      ];
      await this.pool.query(query, values);
      console.log(`[Database] Stored order ticket=${payload.ticket}`);
    } catch (error) {
      console.error('[Database] Failed to store order:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async storeAccountSnapshot(payload: any): Promise<void> {
    if (!this.isConnected) return;
    try {
      const snapshotTime = this.parseEATime(payload.time);
      const query = `
        INSERT INTO account_snapshots (account_id, balance, equity, margin, free_margin, daily_pnl, unrealized_pnl, currency, snapshot_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `;
      const values = [
        payload.account_id,
        payload.balance,
        payload.equity,
        payload.margin,
        payload.free_margin,
        payload.daily_pnl,
        payload.unrealized_pnl,
        payload.currency,
        snapshotTime,
      ];
      await this.pool.query(query, values);
      console.log(`[Database] Stored account snapshot for account_id=${payload.account_id}`);
    } catch (error) {
      console.error('[Database] Failed to store account snapshot:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async storePositions(accountId: number, positions: any[]): Promise<void> {
    if (!this.isConnected) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM open_positions WHERE account_id = $1', [accountId]);

      for (const pos of positions) {
        const posTime = this.parseEATime(pos.time);
        await client.query(
          `INSERT INTO open_positions (ticket, account_id, symbol, type, volume, price_open, price_current, sl, tp, profit, swap, position_time, magic_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            pos.ticket,
            accountId,
            pos.symbol,
            pos.type,
            pos.volume,
            pos.price_open,
            pos.price_current,
            pos.sl || 0,
            pos.tp || 0,
            pos.profit,
            pos.swap,
            posTime,
            pos.magic_number || 0,
          ]
        );
      }

      await client.query('COMMIT');
      console.log(`[Database] Stored ${positions.length} open positions for account_id=${accountId}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Database] Failed to store positions:', error instanceof Error ? error.message : error);
      throw error;
    } finally {
      client.release();
    }
  }

  async storeOpenOrders(accountId: number, orders: any[]): Promise<void> {
    if (!this.isConnected) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM open_orders WHERE account_id = $1', [accountId]);

      for (const order of orders) {
        const orderTime = this.parseEATime(order.time);
        await client.query(
          `INSERT INTO open_orders (ticket, account_id, symbol, type, volume, price, sl, tp, order_time, magic_number, comment)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            order.ticket,
            accountId,
            order.symbol,
            order.type,
            order.volume,
            order.price,
            order.sl || 0,
            order.tp || 0,
            orderTime,
            order.magic_number || 0,
            order.comment || null,
          ]
        );
      }

      await client.query('COMMIT');
      console.log(`[Database] Stored ${orders.length} open orders for account_id=${accountId}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Database] Failed to store open orders:', error instanceof Error ? error.message : error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getOpenOrders(accountId: number): Promise<any[]> {
    try {
      const query = `
        SELECT * FROM open_orders
        WHERE account_id = $1
        ORDER BY order_time DESC
      `;
      const result = await this.pool.query(query, [accountId]);
      return result.rows;
    } catch (error) {
      console.error('[Database] Failed to get open orders:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async getOpenPositions(accountId: number): Promise<any[]> {
    try {
      const query = `
        SELECT * FROM open_positions
        WHERE account_id = $1
        ORDER BY position_time DESC
      `;
      const result = await this.pool.query(query, [accountId]);
      return result.rows;
    } catch (error) {
      console.error('[Database] Failed to get open positions:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async getDealsByAccount(accountId: number, limit: number = 100): Promise<any[]> {
    try {
      const query = `
        SELECT * FROM deals
        WHERE account_id = $1
        ORDER BY deal_time DESC
        LIMIT $2
      `;
      const result = await this.pool.query(query, [accountId, limit]);
      return result.rows;
    } catch (error) {
      console.error('[Database] Failed to get deals:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async getOrdersByAccount(accountId: number, limit: number = 100): Promise<any[]> {
    try {
      const query = `
        SELECT * FROM orders
        WHERE account_id = $1
        ORDER BY order_time DESC
        LIMIT $2
      `;
      const result = await this.pool.query(query, [accountId, limit]);
      return result.rows;
    } catch (error) {
      console.error('[Database] Failed to get orders:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async getLatestSnapshot(accountId: number): Promise<any | null> {
    try {
      const query = `
        SELECT * FROM account_snapshots
        WHERE account_id = $1
        ORDER BY snapshot_time DESC
        LIMIT 1
      `;
      const result = await this.pool.query(query, [accountId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('[Database] Failed to get latest snapshot:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async getAccountSnapshotHistory(accountId: number, since: string): Promise<any[]> {
    try {
      const query = `
        SELECT * FROM account_snapshots
        WHERE account_id = $1 AND snapshot_time > $2
        ORDER BY snapshot_time ASC
      `;
      const result = await this.pool.query(query, [accountId, since]);
      return result.rows;
    } catch (error) {
      console.error('[Database] Failed to get snapshot history:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async getAccounts(): Promise<any[]> {
    try {
      const query = `
        SELECT DISTINCT ON (s.account_id)
          s.account_id,
          s.balance,
          s.equity,
          s.margin,
          s.free_margin,
          s.daily_pnl,
          s.unrealized_pnl,
          s.currency,
          s.snapshot_time
        FROM account_snapshots s
        ORDER BY s.account_id, s.snapshot_time DESC
      `;
      const result = await this.pool.query(query);
      return result.rows;
    } catch (error) {
      console.error('[Database] Failed to get accounts:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async getDailyPnlHistory(accountId: number, days: number = 30): Promise<any[]> {
    try {
      const query = `
        SELECT
          DATE(snapshot_time) as date,
          MAX(daily_pnl) as daily_pnl,
          MAX(balance) as balance,
          MAX(equity) as equity
        FROM account_snapshots
        WHERE account_id = $1
          AND snapshot_time > NOW() - INTERVAL '1 day' * $2
        GROUP BY DATE(snapshot_time)
        ORDER BY date ASC
      `;
      const result = await this.pool.query(query, [accountId, days]);
      return result.rows;
    } catch (error) {
      console.error('[Database] Failed to get daily PnL:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async getAccountStats(accountId: number): Promise<any> {
    try {
      const query = `
        SELECT
          COUNT(*) as total_trades,
          COUNT(*) FILTER (WHERE profit > 0) as winning_trades,
          CASE
            WHEN COUNT(*) > 0
            THEN ROUND(COUNT(*) FILTER (WHERE profit > 0)::numeric / COUNT(*)::numeric * 100, 2)
            ELSE 0
          END as win_rate,
          COALESCE(SUM(profit), 0) as total_pnl,
          COALESCE(SUM(commission), 0) as total_commission,
          COALESCE(SUM(swap), 0) as total_swap
        FROM deals
        WHERE account_id = $1
      `;
      const result = await this.pool.query(query, [accountId]);
      return result.rows[0];
    } catch (error) {
      console.error('[Database] Failed to get account stats:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  // --- Copy Config CRUD ---

  async getCopyConfigs(): Promise<any[]> {
    const result = await this.pool.query('SELECT * FROM copy_configs ORDER BY created_at DESC');
    return result.rows;
  }

  async getCopyConfig(id: number): Promise<any | null> {
    const result = await this.pool.query('SELECT * FROM copy_configs WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async createCopyConfig(sourceAccountId: number, destAccountId: number, volumeMultiplier: number = 1.0): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO copy_configs (source_account_id, dest_account_id, volume_multiplier)
       VALUES ($1, $2, $3) RETURNING *`,
      [sourceAccountId, destAccountId, volumeMultiplier]
    );
    return result.rows[0];
  }

  async updateCopyConfig(id: number, updates: { volume_multiplier?: number; enabled?: boolean }): Promise<any | null> {
    const fields: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const values: any[] = [];
    let paramIdx = 1;

    if (updates.volume_multiplier !== undefined) {
      fields.push(`volume_multiplier = $${paramIdx++}`);
      values.push(updates.volume_multiplier);
    }
    if (updates.enabled !== undefined) {
      fields.push(`enabled = $${paramIdx++}`);
      values.push(updates.enabled);
    }

    values.push(id);
    const result = await this.pool.query(
      `UPDATE copy_configs SET ${fields.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async deleteCopyConfig(id: number): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM copy_configs WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getActiveCopyConfigsBySource(sourceAccountId: number): Promise<any[]> {
    const result = await this.pool.query(
      'SELECT * FROM copy_configs WHERE source_account_id = $1 AND enabled = true',
      [sourceAccountId]
    );
    return result.rows;
  }

  // --- Copy Signals ---

  async createCopySignal(signal: {
    config_id: number;
    source_account_id: number;
    dest_account_id: number;
    signal_type: string;
    symbol?: string;
    direction?: string;
    volume?: number;
    source_position_ticket?: number;
    source_deal_ticket?: number;
    sl?: number;
    tp?: number;
  }): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO copy_signals (config_id, source_account_id, dest_account_id, signal_type, symbol, direction, volume, source_position_ticket, source_deal_ticket, sl, tp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        signal.config_id,
        signal.source_account_id,
        signal.dest_account_id,
        signal.signal_type,
        signal.symbol || null,
        signal.direction || null,
        signal.volume || null,
        signal.source_position_ticket || null,
        signal.source_deal_ticket || null,
        signal.sl || null,
        signal.tp || null,
      ]
    );
    return result.rows[0];
  }

  async updateCopySignalResult(id: number, result: {
    status: string;
    dest_deal_ticket?: number;
    dest_position_ticket?: number;
    dest_price?: number;
    error_message?: string;
  }): Promise<any | null> {
    const res = await this.pool.query(
      `UPDATE copy_signals SET status = $1, dest_deal_ticket = $2, dest_position_ticket = $3, dest_price = $4, error_message = $5, executed_at = CURRENT_TIMESTAMP
       WHERE id = $6 RETURNING *`,
      [
        result.status,
        result.dest_deal_ticket || null,
        result.dest_position_ticket || null,
        result.dest_price || null,
        result.error_message || null,
        id,
      ]
    );
    return res.rows[0] || null;
  }

  async getCopySignals(filters: { limit?: number; config_id?: number; status?: string } = {}): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (filters.config_id) {
      conditions.push(`config_id = $${paramIdx++}`);
      values.push(filters.config_id);
    }
    if (filters.status) {
      conditions.push(`status = $${paramIdx++}`);
      values.push(filters.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit || 50;
    values.push(limit);

    const result = await this.pool.query(
      `SELECT * FROM copy_signals ${where} ORDER BY created_at DESC LIMIT $${paramIdx}`,
      values
    );
    return result.rows;
  }

  async getCopySignal(id: number): Promise<any | null> {
    const result = await this.pool.query('SELECT * FROM copy_signals WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  // --- Position Mapping ---

  async createPositionMapping(mapping: {
    config_id: number;
    source_position_ticket: number;
    dest_position_ticket: number;
    symbol?: string;
  }): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO copy_position_map (config_id, source_position_ticket, dest_position_ticket, symbol)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [mapping.config_id, mapping.source_position_ticket, mapping.dest_position_ticket, mapping.symbol || null]
    );
    return result.rows[0];
  }

  async getDestPositionTicket(configId: number, sourceTicket: number): Promise<number | null> {
    const result = await this.pool.query(
      'SELECT dest_position_ticket FROM copy_position_map WHERE config_id = $1 AND source_position_ticket = $2 AND is_open = true',
      [configId, sourceTicket]
    );
    return result.rows[0]?.dest_position_ticket || null;
  }

  async closePositionMapping(configId: number, sourceTicket: number): Promise<void> {
    await this.pool.query(
      'UPDATE copy_position_map SET is_open = false, closed_at = CURRENT_TIMESTAMP WHERE config_id = $1 AND source_position_ticket = $2 AND is_open = true',
      [configId, sourceTicket]
    );
  }

  async getPositionMappings(filters: { config_id?: number; is_open?: boolean } = {}): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (filters.config_id) {
      conditions.push(`config_id = $${paramIdx++}`);
      values.push(filters.config_id);
    }
    if (filters.is_open !== undefined) {
      conditions.push(`is_open = $${paramIdx++}`);
      values.push(filters.is_open);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM copy_position_map ${where} ORDER BY created_at DESC`,
      values
    );
    return result.rows;
  }

  async disconnect(): Promise<void> {
    try {
      await this.pool.end();
      this.isConnected = false;
      console.log('[Database] Disconnected successfully');
    } catch (error) {
      console.error('[Database] Disconnect error:', error instanceof Error ? error.message : error);
    }
  }
}
