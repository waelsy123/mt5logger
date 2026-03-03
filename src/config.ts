export interface Config {
  databaseUrl: string;
  rabbitmqUrl: string;
  apiKey: string;
  port: number;
}

export function getConfig(): Config {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.error('FATAL: API_KEY environment variable is required');
    process.exit(1);
  }
  return {
    databaseUrl: process.env.DATABASE_URL || '',
    rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://localhost:5672',
    apiKey,
    port: parseInt(process.env.PORT || '3000', 10),
  };
}
