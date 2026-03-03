import amqp, { ChannelModel, Channel } from 'amqplib';
import { DatabaseService } from './database.js';
import { ApiServer } from './api-server.js';

export class RabbitMQConsumer {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private readonly exchangeName = 'mt5.events';
  private readonly queueName = 'mt5.trades';
  private readonly routingKey = 'mt5.#';
  private isConnecting = false;

  constructor(
    private rabbitmqUrl: string,
    private databaseService: DatabaseService,
    private apiServer: ApiServer
  ) {}

  async connect(): Promise<void> {
    if (this.isConnecting) {
      console.log('[RabbitMQ Consumer] Connection already in progress, skipping...');
      return;
    }

    this.isConnecting = true;
    let retries = 0;
    const maxRetries = 10;

    while (retries < maxRetries) {
      try {
        console.log(`[RabbitMQ Consumer] Connecting to ${this.rabbitmqUrl.replace(/:[^:]*@/, ':****@')}...`);
        this.connection = await amqp.connect(this.rabbitmqUrl);
        this.channel = await this.connection.createChannel();

        await this.channel.assertExchange(this.exchangeName, 'topic', {
          durable: true,
        });

        await this.channel.assertQueue(this.queueName, {
          durable: true,
          arguments: {
            'x-message-ttl': 3600000,
            'x-max-length': 10000,
          },
        });

        await this.channel.bindQueue(this.queueName, this.exchangeName, this.routingKey);
        await this.channel.prefetch(1);

        console.log('[RabbitMQ Consumer] Connected and ready');
        this.setupErrorHandlers();
        this.isConnecting = false;
        return;
      } catch (error) {
        retries++;
        const delay = 5000 * retries;
        console.error(
          `[RabbitMQ Consumer] Connection failed (${retries}/${maxRetries}):`,
          error instanceof Error ? error.message : error
        );

        if (retries < maxRetries) {
          console.log(`[RabbitMQ Consumer] Retrying in ${delay / 1000}s...`);
          await this.sleep(delay);
        }
      }
    }

    this.isConnecting = false;
    throw new Error('Failed to connect to RabbitMQ after max retries');
  }

  async startConsuming(): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not initialized');
    }

    console.log('[RabbitMQ Consumer] Starting to consume messages...');

    await this.channel.consume(this.queueName, async (msg) => {
      if (!msg) return;

      try {
        const message = JSON.parse(msg.content.toString());
        const routingKey = msg.fields.routingKey;
        console.log(`[Consumer] Received message: ${message.messageId} (${routingKey})`);

        const data = message.data;

        if (routingKey === 'mt5.deal.new') {
          await this.databaseService.storeDeal(data);
          this.apiServer.broadcastEvent('deal', data);
          await this.generateCopySignals(data, 'deal');
        } else if (routingKey === 'mt5.order.new') {
          await this.databaseService.storeOrder(data);
          this.apiServer.broadcastEvent('order', data);
        } else if (routingKey === 'mt5.account.snapshot') {
          await this.databaseService.storeAccountSnapshot(data);
          this.apiServer.broadcastEvent('account', data);
        } else if (routingKey === 'mt5.positions.snapshot') {
          await this.databaseService.storePositions(data.account_id, data.positions || []);
          this.apiServer.broadcastEvent('positions', data);
        } else if (routingKey === 'mt5.open_orders.snapshot') {
          await this.databaseService.storeOpenOrders(data.account_id, data.orders || []);
          this.apiServer.broadcastEvent('open_orders', data);
        } else if (routingKey === 'mt5.position.modify') {
          this.apiServer.broadcastEvent('position_modify', data);
          await this.generateCopySignals(data, 'position_modify');
        } else {
          console.warn(`[Consumer] Unknown routing key: ${routingKey}`);
        }

        this.channel!.ack(msg);
        console.log(`[Consumer] Message ${message.messageId} processed successfully`);
      } catch (error) {
        console.error('[Consumer] Error processing message:', error instanceof Error ? error.message : error);
        this.channel!.nack(msg, false, false);
      }
    });

    console.log('[RabbitMQ Consumer] Now listening for messages');
  }

  private async generateCopySignals(data: any, eventType: 'deal' | 'position_modify'): Promise<void> {
    try {
      const sourceAccountId = data.account_id;
      if (!sourceAccountId) return;

      const configs = await this.databaseService.getActiveCopyConfigsBySource(sourceAccountId);
      if (configs.length === 0) return;

      console.log(`[CopyTrading] Found ${configs.length} active config(s) for source account ${sourceAccountId}`);

      for (const config of configs) {
        try {
          if (eventType === 'deal') {
            await this.generateDealCopySignal(data, config);
          } else if (eventType === 'position_modify') {
            await this.generateModifyCopySignal(data, config);
          }
        } catch (err) {
          console.error(`[CopyTrading] Error generating signal for config ${config.id}:`, err instanceof Error ? err.message : err);
        }
      }
    } catch (error) {
      console.error('[CopyTrading] Error in generateCopySignals:', error instanceof Error ? error.message : error);
    }
  }

  private async generateDealCopySignal(data: any, config: any): Promise<void> {
    const entry = data.entry;
    if (!entry) return;

    // Determine direction from deal type
    const dealType = data.type || '';
    let direction: string | undefined;
    if (dealType.includes('BUY')) direction = 'BUY';
    else if (dealType.includes('SELL')) direction = 'SELL';

    if (entry === 'DEAL_ENTRY_IN') {
      // Opening trade — create open signal
      const volume = parseFloat(data.volume || 0) * parseFloat(config.volume_multiplier);
      const signal = await this.databaseService.createCopySignal({
        config_id: config.id,
        source_account_id: config.source_account_id,
        dest_account_id: config.dest_account_id,
        signal_type: 'open',
        symbol: data.symbol,
        direction,
        volume: Math.round(volume * 100) / 100,
        source_position_ticket: data.position_ticket,
        source_deal_ticket: data.ticket,
        sl: data.sl || 0,
        tp: data.tp || 0,
      });
      console.log(`[CopyTrading] Created OPEN signal #${signal.id} for config ${config.id}`);
      this.apiServer.sendToExecutor(signal);
    } else if (entry === 'DEAL_ENTRY_OUT' || entry === 'DEAL_ENTRY_INOUT') {
      // Closing trade — look up dest position ticket from map
      const destTicket = await this.databaseService.getDestPositionTicket(config.id, data.position_ticket);
      if (!destTicket) {
        console.warn(`[CopyTrading] No position mapping found for source ticket ${data.position_ticket} in config ${config.id}`);
        return;
      }

      const signal = await this.databaseService.createCopySignal({
        config_id: config.id,
        source_account_id: config.source_account_id,
        dest_account_id: config.dest_account_id,
        signal_type: 'close',
        symbol: data.symbol,
        direction,
        source_position_ticket: data.position_ticket,
        source_deal_ticket: data.ticket,
      });
      // Embed dest_position_ticket for the executor
      (signal as any).dest_position_ticket = destTicket;
      console.log(`[CopyTrading] Created CLOSE signal #${signal.id} for config ${config.id} (dest ticket: ${destTicket})`);
      this.apiServer.sendToExecutor(signal);
    }
  }

  private async generateModifyCopySignal(data: any, config: any): Promise<void> {
    const destTicket = await this.databaseService.getDestPositionTicket(config.id, data.position_ticket);
    if (!destTicket) {
      console.warn(`[CopyTrading] No position mapping found for source ticket ${data.position_ticket} in config ${config.id}`);
      return;
    }

    const signal = await this.databaseService.createCopySignal({
      config_id: config.id,
      source_account_id: config.source_account_id,
      dest_account_id: config.dest_account_id,
      signal_type: 'modify',
      symbol: data.symbol,
      source_position_ticket: data.position_ticket,
      sl: data.sl || 0,
      tp: data.tp || 0,
    });
    // Embed dest_position_ticket for the executor
    (signal as any).dest_position_ticket = destTicket;
    console.log(`[CopyTrading] Created MODIFY signal #${signal.id} for config ${config.id} (dest ticket: ${destTicket})`);
    this.apiServer.sendToExecutor(signal);
  }

  private setupErrorHandlers(): void {
    if (!this.connection) return;

    this.connection.on('error', (err) => {
      console.error('[RabbitMQ Consumer] Connection error:', err.message);
    });

    this.connection.on('close', () => {
      console.log('[RabbitMQ Consumer] Connection closed, attempting reconnect in 5s...');
      this.channel = null;
      this.connection = null;
      setTimeout(() => {
        this.connect()
          .then(() => this.startConsuming())
          .catch((err) => {
            console.error('[RabbitMQ Consumer] Reconnection failed:', err.message);
          });
      }, 5000);
    });

    if (this.channel) {
      this.channel.on('error', (err) => {
        console.error('[RabbitMQ Consumer] Channel error:', err.message);
      });

      this.channel.on('close', () => {
        console.log('[RabbitMQ Consumer] Channel closed');
      });
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
      console.log('[RabbitMQ Consumer] Disconnected');
    } catch (error) {
      console.error('[RabbitMQ Consumer] Error during disconnect:', error instanceof Error ? error.message : error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
