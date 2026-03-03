import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HTTPServer, IncomingMessage } from 'http';
import { DatabaseService } from './database.js';
import { RabbitMQPublisher } from './rabbitmq-publisher.js';

interface ExecutorConnection {
  ws: WebSocket;
  lastHeartbeat: number;
}

export class ApiServer {
  private app: Express;
  private server: HTTPServer | null = null;
  private wss: WebSocketServer | null = null;
  private executorWss: WebSocketServer | null = null;
  private executors: Map<number, ExecutorConnection> = new Map();
  private pendingCommands: Map<number, Set<string>> = new Map();

  constructor(
    private port: number,
    private databaseService: DatabaseService,
    private rabbitmqPublisher: RabbitMQPublisher,
    private apiKey: string
  ) {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
  }

  private validateBearerAuth(req: Request): boolean {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }
    return authHeader.slice(7) === this.apiKey;
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    });

    // Webhook — bearer auth required
    this.app.post('/webhook', async (req: Request, res: Response) => {
      if (!this.validateBearerAuth(req)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      try {
        const payload = req.body;

        if (!payload.event_type) {
          res.status(400).json({ error: 'Missing required field: event_type' });
          return;
        }

        const eventType = payload.event_type;
        const accountId = payload.account_id ? Number(payload.account_id) : 0;

        if (eventType === 'deal') {
          this.rabbitmqPublisher.publishDealEvent(payload);
        } else if (eventType === 'order') {
          this.rabbitmqPublisher.publishOrderEvent(payload);
        } else if (eventType === 'account') {
          this.rabbitmqPublisher.publishAccountEvent(payload);
        } else if (eventType === 'positions') {
          this.rabbitmqPublisher.publishPositionsEvent(payload);
        } else if (eventType === 'open_orders') {
          this.rabbitmqPublisher.publishOpenOrdersEvent(payload);
        } else if (eventType === 'position_modify') {
          this.rabbitmqPublisher.publishPositionModifyEvent(payload);
        } else {
          res.status(400).json({ error: `Unknown event_type: ${eventType}` });
          return;
        }

        console.log(`[API] Webhook received: ${eventType} event`);

        // Reactive commands: trade events trigger immediate data requests
        if (eventType === 'deal' || eventType === 'order' || eventType === 'position_modify') {
          const commands = ['send_positions', 'send_account', 'send_open_orders'];
          console.log(`[API] Trade event — requesting data refresh from EA`);
          res.json({ status: 'received', commands });
          return;
        }

        // Data events: only return queued on-demand commands (prevents infinite loop)
        if (accountId && this.pendingCommands.has(accountId)) {
          const queued = this.pendingCommands.get(accountId)!;
          if (queued.size > 0) {
            const commands = Array.from(queued);
            this.pendingCommands.delete(accountId);
            console.log(`[API] Delivering queued commands for account ${accountId}: ${commands.join(', ')}`);
            res.json({ status: 'received', commands });
            return;
          }
        }

        res.json({ status: 'received' });
      } catch (error) {
        console.error('[API] Webhook error:', error instanceof Error ? error.message : error);
        res.status(400).json({ error: 'Invalid JSON payload' });
      }
    });

    // Get all accounts with latest snapshot
    this.app.get('/accounts', async (_req: Request, res: Response) => {
      try {
        const accounts = await this.databaseService.getAccounts();
        res.json({ success: true, accounts });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch accounts' });
      }
    });

    // Get latest snapshot for an account
    this.app.get('/accounts/:id', async (req: Request, res: Response) => {
      try {
        const accountId = parseInt(req.params.id as string, 10);
        const snapshot = await this.databaseService.getLatestSnapshot(accountId);
        if (!snapshot) {
          res.status(404).json({ success: false, error: 'Account not found' });
          return;
        }
        res.json({ success: true, account: snapshot });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch account' });
      }
    });

    // Get deals for an account
    this.app.get('/accounts/:id/deals', async (req: Request, res: Response) => {
      try {
        const accountId = parseInt(req.params.id as string, 10);
        const limit = parseInt(req.query.limit as string) || 100;
        const deals = await this.databaseService.getDealsByAccount(accountId, limit);
        res.json({ success: true, count: deals.length, deals });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch deals' });
      }
    });

    // Get open positions for an account
    this.app.get('/accounts/:id/positions', async (req: Request, res: Response) => {
      try {
        const accountId = parseInt(req.params.id as string, 10);
        const positions = await this.databaseService.getOpenPositions(accountId);
        res.json({ success: true, count: positions.length, positions });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch positions' });
      }
    });

    // Get orders for an account
    this.app.get('/accounts/:id/orders', async (req: Request, res: Response) => {
      try {
        const accountId = parseInt(req.params.id as string, 10);
        const limit = parseInt(req.query.limit as string) || 100;
        const orders = await this.databaseService.getOrdersByAccount(accountId, limit);
        res.json({ success: true, count: orders.length, orders });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch orders' });
      }
    });

    // Get snapshot history for an account
    this.app.get('/accounts/:id/snapshots', async (req: Request, res: Response) => {
      try {
        const accountId = parseInt(req.params.id as string, 10);
        const since = (req.query.since as string) || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const snapshots = await this.databaseService.getAccountSnapshotHistory(accountId, since);
        res.json({ success: true, count: snapshots.length, snapshots });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch snapshots' });
      }
    });

    // Get daily PnL history for an account
    this.app.get('/accounts/:id/daily-pnl', async (req: Request, res: Response) => {
      try {
        const accountId = parseInt(req.params.id as string, 10);
        const days = parseInt(req.query.days as string) || 30;
        const history = await this.databaseService.getDailyPnlHistory(accountId, days);
        res.json({ success: true, count: history.length, history });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch daily PnL' });
      }
    });

    // Get account stats (win rate, total PnL, etc.)
    this.app.get('/accounts/:id/stats', async (req: Request, res: Response) => {
      try {
        const accountId = parseInt(req.params.id as string, 10);
        const stats = await this.databaseService.getAccountStats(accountId);
        res.json({ success: true, stats });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch stats' });
      }
    });

    // Get open orders for an account
    this.app.get('/accounts/:id/open-orders', async (req: Request, res: Response) => {
      try {
        const accountId = parseInt(req.params.id as string, 10);
        const orders = await this.databaseService.getOpenOrders(accountId);
        res.json({ success: true, count: orders.length, orders });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch open orders' });
      }
    });

    // Request refresh — queues commands for the EA to pick up on next timer tick
    this.app.post('/accounts/:id/request-refresh', async (req: Request, res: Response) => {
      try {
        const accountId = parseInt(req.params.id as string, 10);
        const commands = new Set(['send_positions', 'send_account', 'send_open_orders']);
        this.pendingCommands.set(accountId, commands);
        console.log(`[API] Queued refresh commands for account ${accountId}`);
        res.json({ success: true, message: 'Refresh commands queued for next EA tick' });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to queue refresh' });
      }
    });

    // --- Copy Trading CRUD ---

    // Get all copy configs
    this.app.get('/copy/configs', async (_req: Request, res: Response) => {
      try {
        const configs = await this.databaseService.getCopyConfigs();
        res.json({ success: true, configs });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch configs' });
      }
    });

    // Create copy config
    this.app.post('/copy/configs', async (req: Request, res: Response) => {
      try {
        const { source_account_id, dest_account_id, volume_multiplier } = req.body;
        if (!source_account_id || !dest_account_id) {
          res.status(400).json({ success: false, error: 'source_account_id and dest_account_id are required' });
          return;
        }
        const config = await this.databaseService.createCopyConfig(
          Number(source_account_id),
          Number(dest_account_id),
          volume_multiplier ? Number(volume_multiplier) : 1.0
        );
        res.json({ success: true, config });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to create config' });
      }
    });

    // Get single copy config
    this.app.get('/copy/configs/:id', async (req: Request, res: Response) => {
      try {
        const config = await this.databaseService.getCopyConfig(parseInt(req.params.id as string, 10));
        if (!config) {
          res.status(404).json({ success: false, error: 'Config not found' });
          return;
        }
        res.json({ success: true, config });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch config' });
      }
    });

    // Update copy config
    this.app.put('/copy/configs/:id', async (req: Request, res: Response) => {
      try {
        const updates: { volume_multiplier?: number; enabled?: boolean } = {};
        if (req.body.volume_multiplier !== undefined) updates.volume_multiplier = Number(req.body.volume_multiplier);
        if (req.body.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);

        const config = await this.databaseService.updateCopyConfig(parseInt(req.params.id as string, 10), updates);
        if (!config) {
          res.status(404).json({ success: false, error: 'Config not found' });
          return;
        }
        res.json({ success: true, config });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to update config' });
      }
    });

    // Delete copy config
    this.app.delete('/copy/configs/:id', async (req: Request, res: Response) => {
      try {
        const deleted = await this.databaseService.deleteCopyConfig(parseInt(req.params.id as string, 10));
        if (!deleted) {
          res.status(404).json({ success: false, error: 'Config not found' });
          return;
        }
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to delete config' });
      }
    });

    // Get copy signals
    this.app.get('/copy/signals', async (req: Request, res: Response) => {
      try {
        const filters: { limit?: number; config_id?: number; status?: string } = {};
        if (req.query.limit) filters.limit = parseInt(req.query.limit as string);
        if (req.query.config_id) filters.config_id = parseInt(req.query.config_id as string);
        if (req.query.status) filters.status = req.query.status as string;

        const signals = await this.databaseService.getCopySignals(filters);
        res.json({ success: true, count: signals.length, signals });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch signals' });
      }
    });

    // Get single copy signal
    this.app.get('/copy/signals/:id', async (req: Request, res: Response) => {
      try {
        const signal = await this.databaseService.getCopySignal(parseInt(req.params.id as string, 10));
        if (!signal) {
          res.status(404).json({ success: false, error: 'Signal not found' });
          return;
        }
        res.json({ success: true, signal });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch signal' });
      }
    });

    // Get position mappings
    this.app.get('/copy/position-map', async (req: Request, res: Response) => {
      try {
        const filters: { config_id?: number; is_open?: boolean } = {};
        if (req.query.config_id) filters.config_id = parseInt(req.query.config_id as string);
        if (req.query.is_open !== undefined) filters.is_open = req.query.is_open === 'true';

        const mappings = await this.databaseService.getPositionMappings(filters);
        res.json({ success: true, count: mappings.length, mappings });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch position mappings' });
      }
    });

    // Get executor status
    this.app.get('/copy/executor/status', async (_req: Request, res: Response) => {
      try {
        const statuses: any[] = [];
        this.executors.forEach((exec, accountId) => {
          statuses.push({
            account_id: accountId,
            connected: exec.ws.readyState === WebSocket.OPEN,
            last_heartbeat: new Date(exec.lastHeartbeat).toISOString(),
          });
        });
        res.json({ success: true, executors: statuses });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to fetch executor status' });
      }
    });

    // 404 handler
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({
        error: 'Endpoint not found',
        availableEndpoints: [
          'GET /health',
          'POST /webhook',
          'GET /accounts',
          'GET /accounts/:id',
          'GET /accounts/:id/deals?limit=100',
          'GET /accounts/:id/positions',
          'GET /accounts/:id/orders?limit=100',
          'GET /accounts/:id/open-orders',
          'POST /accounts/:id/request-refresh',
          'GET /accounts/:id/snapshots?since=<iso>',
          'GET /accounts/:id/daily-pnl?days=30',
          'GET /accounts/:id/stats',
          'GET /copy/configs',
          'POST /copy/configs',
          'GET /copy/configs/:id',
          'PUT /copy/configs/:id',
          'DELETE /copy/configs/:id',
          'GET /copy/signals?limit=50&config_id=&status=',
          'GET /copy/signals/:id',
          'GET /copy/position-map?config_id=&is_open=true',
          'GET /copy/executor/status',
        ],
      });
    });
  }

  broadcastEvent(type: string, data: any): void {
    if (!this.wss) return;

    const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });

    let sentCount = 0;
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
        sentCount++;
      }
    });

    if (sentCount > 0) {
      console.log(`[WebSocket] Broadcasted ${type} event to ${sentCount} client(s)`);
    }
  }

  sendToExecutor(signal: any): void {
    const destAccountId = Number(signal.dest_account_id);
    const executor = this.executors.get(destAccountId);

    if (!executor || executor.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[Executor] No connected executor for dest account ${destAccountId}, marking signal ${signal.id} as failed`);
      this.databaseService.updateCopySignalResult(signal.id, {
        status: 'failed',
        error_message: 'No executor connected for destination account',
      }).catch(err => console.error('[Executor] Failed to update signal:', err));
      return;
    }

    const message = JSON.stringify({ type: 'signal', signal });
    executor.ws.send(message);

    this.databaseService.updateCopySignalResult(signal.id, { status: 'sent' })
      .catch(err => console.error('[Executor] Failed to update signal status to sent:', err));

    console.log(`[Executor] Sent signal #${signal.id} to executor for account ${destAccountId}`);
  }

  private async handleSignalResult(msg: any): Promise<void> {
    try {
      const { signal_id, status, dest_deal_ticket, dest_position_ticket, dest_price, error_message } = msg;

      if (!signal_id) {
        console.warn('[Executor] Received signal_result without signal_id');
        return;
      }

      const updatedSignal = await this.databaseService.updateCopySignalResult(signal_id, {
        status,
        dest_deal_ticket,
        dest_position_ticket,
        dest_price,
        error_message,
      });

      if (!updatedSignal) {
        console.warn(`[Executor] Signal #${signal_id} not found for result update`);
        return;
      }

      console.log(`[Executor] Signal #${signal_id} result: ${status}`);

      if (status === 'filled') {
        if (updatedSignal.signal_type === 'open' && dest_position_ticket) {
          await this.databaseService.createPositionMapping({
            config_id: updatedSignal.config_id,
            source_position_ticket: updatedSignal.source_position_ticket,
            dest_position_ticket,
            symbol: updatedSignal.symbol,
          });
          console.log(`[Executor] Created position mapping: source ${updatedSignal.source_position_ticket} -> dest ${dest_position_ticket}`);
        } else if (updatedSignal.signal_type === 'close') {
          await this.databaseService.closePositionMapping(
            updatedSignal.config_id,
            updatedSignal.source_position_ticket
          );
          console.log(`[Executor] Closed position mapping for source ticket ${updatedSignal.source_position_ticket}`);
        }
      }

      // Broadcast result to frontend clients
      this.broadcastEvent('copy_signal_result', { signal_id, status, ...updatedSignal });
    } catch (error) {
      console.error('[Executor] Error handling signal result:', error instanceof Error ? error.message : error);
    }
  }

  start(): HTTPServer {
    this.server = this.app.listen(this.port, () => {
      console.log(`[API] HTTP server listening on port ${this.port}`);
    });

    this.setupWebSocket();

    return this.server;
  }

  private setupWebSocket(): void {
    if (!this.server) return;

    // Frontend WebSocket (noServer mode)
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const ip =
        req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
        req.headers['x-real-ip']?.toString() ||
        req.socket?.remoteAddress ||
        'unknown';

      console.log(`[WebSocket] Client connected from ${ip}`);

      ws.send(
        JSON.stringify({
          type: 'connected',
          message: 'Connected to MT5 Trade Logger WebSocket',
          timestamp: new Date().toISOString(),
        })
      );

      (ws as any).isAlive = true;

      ws.on('pong', () => {
        (ws as any).isAlive = true;
      });

      ws.on('close', () => {
        console.log(`[WebSocket] Client disconnected from ${ip}`);
      });

      ws.on('error', (error) => {
        console.error(`[WebSocket] Client error from ${ip}:`, error);
      });
    });

    // Executor WebSocket (noServer mode)
    this.executorWss = new WebSocketServer({ noServer: true });

    this.executorWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const accountId = Number(url.searchParams.get('account'));

      console.log(`[Executor WS] Executor connected for account ${accountId}`);

      this.executors.set(accountId, { ws, lastHeartbeat: Date.now() });

      ws.send(JSON.stringify({ type: 'connected', account_id: accountId }));

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'signal_result') {
            this.handleSignalResult(msg);
          } else if (msg.type === 'heartbeat') {
            const exec = this.executors.get(accountId);
            if (exec) exec.lastHeartbeat = Date.now();
          }
        } catch (err) {
          console.error(`[Executor WS] Invalid message from account ${accountId}:`, err);
        }
      });

      ws.on('close', () => {
        console.log(`[Executor WS] Executor disconnected for account ${accountId}`);
        this.executors.delete(accountId);
      });

      ws.on('error', (error) => {
        console.error(`[Executor WS] Error for account ${accountId}:`, error);
      });
    });

    // Upgrade handler — route to correct WSS based on path
    this.server.on('upgrade', (request: IncomingMessage, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      const pathname = url.pathname;

      if (pathname === '/ws') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      } else if (pathname === '/ws/executor') {
        // Auth check for executor
        const token = url.searchParams.get('token');
        const accountId = url.searchParams.get('account');

        if (token !== this.apiKey || !accountId) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        this.executorWss!.handleUpgrade(request, socket, head, (ws) => {
          this.executorWss!.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    // Heartbeat: ping every 30s, terminate if no pong
    const heartbeat = setInterval(() => {
      if (this.wss) {
        this.wss.clients.forEach((ws) => {
          if ((ws as any).isAlive === false) {
            console.log('[WebSocket] Terminating unresponsive client');
            return ws.terminate();
          }
          (ws as any).isAlive = false;
          ws.ping();
        });
      }
    }, 30000);

    this.wss.on('close', () => {
      clearInterval(heartbeat);
    });

    console.log(`[WebSocket] Server initialized on /ws and /ws/executor`);
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.wss) {
        this.wss.close(() => {
          console.log('[WebSocket] Frontend WS server stopped');
        });
      }

      if (this.executorWss) {
        this.executorWss.close(() => {
          console.log('[WebSocket] Executor WS server stopped');
        });
      }

      if (this.server) {
        this.server.close((err: Error | undefined) => {
          if (err) {
            reject(err);
          } else {
            console.log('[API] HTTP server stopped');
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}
