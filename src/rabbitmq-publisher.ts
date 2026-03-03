import amqp, { ChannelModel, Channel } from 'amqplib';
import { v4 as uuidv4 } from 'uuid';

export class RabbitMQPublisher {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private readonly exchangeName = 'mt5.events';
  private isConnected = false;

  constructor(private rabbitmqUrl: string) {}

  async connect(): Promise<void> {
    try {
      console.log('[RabbitMQ Publisher] Connecting...');
      this.connection = await amqp.connect(this.rabbitmqUrl);
      this.channel = await this.connection.createChannel();

      await this.channel.assertExchange(this.exchangeName, 'topic', {
        durable: true,
      });

      this.isConnected = true;
      console.log('[RabbitMQ Publisher] Connected');

      this.connection.on('error', (err) => {
        console.error('[RabbitMQ Publisher] Connection error:', err.message);
        this.isConnected = false;
      });

      this.connection.on('close', () => {
        console.log('[RabbitMQ Publisher] Connection closed');
        this.isConnected = false;
      });

      if (this.channel) {
        this.channel.on('error', (err) => {
          console.error('[RabbitMQ Publisher] Channel error:', err.message);
        });
      }
    } catch (error) {
      console.error('[RabbitMQ Publisher] Failed to connect:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  private publish(routingKey: string, data: any): void {
    if (!this.isConnected || !this.channel) {
      throw new Error('Publisher not connected to RabbitMQ');
    }

    const messageId = uuidv4();
    const message = {
      messageId,
      timestamp: Date.now(),
      routingKey,
      data,
    };

    const buffer = Buffer.from(JSON.stringify(message));

    this.channel.publish(this.exchangeName, routingKey, buffer, {
      persistent: true,
      contentType: 'application/json',
      messageId,
    });

    console.log(`[RabbitMQ Publisher] Published ${routingKey}: ${messageId}`);
  }

  publishDealEvent(deal: any): void {
    this.publish('mt5.deal.new', deal);
  }

  publishOrderEvent(order: any): void {
    this.publish('mt5.order.new', order);
  }

  publishAccountEvent(snapshot: any): void {
    this.publish('mt5.account.snapshot', snapshot);
  }

  publishPositionsEvent(data: any): void {
    this.publish('mt5.positions.snapshot', data);
  }

  publishOpenOrdersEvent(data: any): void {
    this.publish('mt5.open_orders.snapshot', data);
  }

  async disconnect(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
      this.isConnected = false;
      console.log('[RabbitMQ Publisher] Disconnected');
    } catch (error) {
      console.error('[RabbitMQ Publisher] Disconnect error:', error instanceof Error ? error.message : error);
    }
  }

  getStatus(): boolean {
    return this.isConnected;
  }
}
