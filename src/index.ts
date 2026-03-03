import dotenv from 'dotenv';
import { getConfig } from './config.js';
import { DatabaseService } from './database.js';
import { RabbitMQPublisher } from './rabbitmq-publisher.js';
import { RabbitMQConsumer } from './rabbitmq-consumer.js';
import { ApiServer } from './api-server.js';

dotenv.config();

async function main() {
  console.log('========================================');
  console.log('  MT5 Trade Logger Service');
  console.log('========================================\n');

  try {
    const config = getConfig();
    console.log('[Config] Loaded configuration');
    console.log(`[Config] RabbitMQ URL: ${config.rabbitmqUrl.replace(/:[^:]*@/, ':****@')}`);
    console.log(`[Config] API Port: ${config.port}`);
    console.log(`[Config] Database Configured: ${!!config.databaseUrl}\n`);

    // Initialize Database
    const db = new DatabaseService(config.databaseUrl);
    await db.connect();
    console.log('[Database] Connected and initialized\n');

    // Initialize RabbitMQ Publisher
    const publisher = new RabbitMQPublisher(config.rabbitmqUrl);
    await publisher.connect();
    console.log('[RabbitMQ Publisher] Connected\n');

    // Initialize API Server
    const apiServer = new ApiServer(config.port, db, publisher, config.apiKey);
    const httpServer = apiServer.start();
    console.log(`[API] Server started on port ${config.port}\n`);

    // Initialize RabbitMQ Consumer
    const consumer = new RabbitMQConsumer(config.rabbitmqUrl, db, apiServer);
    await consumer.connect();
    await consumer.startConsuming();
    console.log('[RabbitMQ Consumer] Connected and consuming messages\n');

    console.log('[Service] MT5 Trade Logger started successfully\n');

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\n[Service] Shutting down gracefully...');
      await consumer.disconnect();
      await publisher.disconnect();
      await apiServer.stop();
      await db.disconnect();
      console.log('[Service] Shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('[Service] Fatal error:', error);
    process.exit(1);
  }
}

main();
