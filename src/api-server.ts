import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HTTPServer } from 'http';
import { DatabaseService } from './database.js';
import { RabbitMQPublisher } from './rabbitmq-publisher.js';

export class ApiServer {
  private app: Express;
  private server: HTTPServer | null = null;
  private wss: WebSocketServer | null = null;

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

        if (eventType === 'deal') {
          this.rabbitmqPublisher.publishDealEvent(payload);
        } else if (eventType === 'order') {
          this.rabbitmqPublisher.publishOrderEvent(payload);
        } else if (eventType === 'account') {
          this.rabbitmqPublisher.publishAccountEvent(payload);
        } else if (eventType === 'positions') {
          this.rabbitmqPublisher.publishPositionsEvent(payload);
        } else {
          res.status(400).json({ error: `Unknown event_type: ${eventType}` });
          return;
        }

        console.log(`[API] Webhook received: ${eventType} event`);
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
          'GET /accounts/:id/snapshots?since=<iso>',
          'GET /accounts/:id/daily-pnl?days=30',
          'GET /accounts/:id/stats',
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

  start(): HTTPServer {
    this.server = this.app.listen(this.port, () => {
      console.log(`[API] HTTP server listening on port ${this.port}`);
    });

    this.setupWebSocket();

    return this.server;
  }

  private setupWebSocket(): void {
    if (!this.server) return;

    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket, req: any) => {
      const ip =
        req.headers['x-forwarded-for']?.split(',')[0].trim() ||
        req.headers['x-real-ip'] ||
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

    console.log(`[WebSocket] Server initialized on /ws`);
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.wss) {
        this.wss.close(() => {
          console.log('[WebSocket] Server stopped');
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
