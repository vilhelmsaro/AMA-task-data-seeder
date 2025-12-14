import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

@Injectable()
export class BullmqService implements OnModuleDestroy {
  private readonly logger = new Logger(BullmqService.name);
  private queue: Queue | null = null;
  private redisClient: Redis | null = null;

  async initialize(): Promise<{ queue: Queue; redisClient: Redis }> {
    // Check if Sentinel configuration is provided
    const useSentinel = process.env.REDIS_USE_SENTINEL === 'true';
    const sentinelHosts = process.env.REDIS_SENTINEL_HOSTS;
    const sentinelMasterName =
      process.env.REDIS_SENTINEL_MASTER_NAME || 'mymaster';

    // Debug logging
    this.logger.debug(
      `REDIS_USE_SENTINEL=${process.env.REDIS_USE_SENTINEL}, useSentinel=${useSentinel}`,
    );
    this.logger.debug(`REDIS_SENTINEL_HOSTS=${sentinelHosts}`);
    this.logger.debug(
      `useSentinel && sentinelHosts = ${useSentinel && !!sentinelHosts}`,
    );

    let redisConfig: any;
    let connectionString: string;

    if (useSentinel && sentinelHosts) {
      // Parse Sentinel hosts (format: "host1:port1,host2:port2,host3:port3")
      const sentinels = sentinelHosts.split(',').map((hostPort) => {
        const [host, port] = hostPort.trim().split(':');
        return {
          host: host || 'localhost',
          port: parseInt(port || '26379', 10),
        };
      });

      this.logger.log(
        `Using Redis Sentinel with ${sentinels.length} sentinel(s) for master: ${sentinelMasterName}`,
      );
      sentinels.forEach((sentinel, index) => {
        this.logger.log(
          `  Sentinel ${index + 1}: ${sentinel.host}:${sentinel.port}`,
        );
      });

      // Create Redis connection via Sentinel
      // Sentinel automatically handles failover and redirects to current master
      redisConfig = {
        sentinels: sentinels,
        name: sentinelMasterName,
        retryStrategy: (times: number) => {
          // Exponential backoff for retries
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: null, // Allow unlimited retries
        enableOfflineQueue: false, // Disable offline queue - errors thrown immediately when Redis is down
        lazyConnect: false, // Connect immediately
        // Sentinel-specific options
        sentinelRetryStrategy: (times: number) => {
          // Retry connecting to Sentinel with exponential backoff
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        enableReadyCheck: true, // Wait for Redis to be ready
      };

      connectionString = `Sentinel (${sentinels.length} sentinels) -> ${sentinelMasterName}`;
    } else {
      // Fallback to direct connection (for development/testing)
      const redisHost = process.env.REDIS_HOST || 'localhost';
      const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);

      this.logger.warn(
        `Using direct Redis connection (not via Sentinel): ${redisHost}:${redisPort}`,
      );
      this.logger.warn(
        'For production with failover support, set REDIS_USE_SENTINEL=true and REDIS_SENTINEL_HOSTS',
      );

      redisConfig = {
        host: redisHost,
        port: redisPort,
        retryStrategy: (times: number) => {
          // Exponential backoff for retries
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: null, // Allow unlimited retries
        enableOfflineQueue: false, // Disable offline queue - errors thrown immediately when Redis is down
        lazyConnect: false, // Connect immediately
      };

      connectionString = `${redisHost}:${redisPort}`;
    }

    // Create Redis client
    this.redisClient = new Redis(redisConfig);

    // Create BullMQ queue with same configuration
    this.queue = new Queue('car-seeder-queue', {
      connection: redisConfig,
    });

    this.logger.log(`BullMQ queue initialized: car-seeder-queue`);
    this.logger.log(`Redis connection: ${connectionString}`);

    // Wait for Redis connection to be ready
    await this.waitForConnection();

    return {
      queue: this.queue,
      redisClient: this.redisClient,
    };
  }

  private async waitForConnection(timeout = 30000): Promise<void> {
    if (!this.redisClient) {
      throw new Error('Redis client not initialized');
    }

    const client = this.redisClient;

    // If already ready, verify with ping
    if (client.status === 'ready') {
      try {
        const result = await this.pingWithRetry(client, 3);
        if (result === 'PONG') {
          this.logger.log('Redis connection ready and verified');
          return;
        }
      } catch (error: any) {
        this.logger.warn(
          `Redis ping failed even though status is ready: ${error.message}`,
        );
        // Continue to wait for ready event
      }
    }

    // Wait for 'ready' event with timeout, then verify with ping
    return new Promise((resolve, reject) => {
      if (!client) {
        reject(new Error('Redis client not initialized'));
        return;
      }

      const timeoutId = setTimeout(() => {
        client.removeListener('ready', onReady);
        reject(
          new Error(
            'Redis connection timeout - connection not ready after 30 seconds',
          ),
        );
      }, timeout);

      const onReady = async () => {
        clearTimeout(timeoutId);

        // Verify connection with ping after ready event
        try {
          // Small delay to ensure connection is fully ready
          await new Promise((resolve) => setTimeout(resolve, 200));
          const result = await this.pingWithRetry(client, 5);
          if (result === 'PONG') {
            this.logger.log('Redis connection ready and verified');
            resolve();
          } else {
            reject(new Error('Redis ping returned unexpected result'));
          }
        } catch (error: any) {
          reject(
            new Error(
              `Redis connection ready but ping failed: ${error.message}`,
            ),
          );
        }
      };

      // Don't listen to errors during initialization - retry strategy will handle reconnection
      // We only care about the 'ready' event or timeout
      if (client.status === 'ready') {
        // Already ready, verify with ping
        onReady().catch(reject);
      } else {
        client.once('ready', onReady);
        // Note: We don't listen to 'error' events here because:
        // 1. The retry strategy will handle reconnection automatically
        // 2. We only want to reject on timeout, not on transient connection errors
        // 3. If connection fails permanently, the timeout will catch it
      }
    });
  }

  private async pingWithRetry(
    client: Redis,
    maxRetries: number = 3,
  ): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check if connection is ready before attempting ping
        if (client.status !== 'ready') {
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
          continue;
        }

        const result = await client.ping();
        return result;
      } catch (error: any) {
        lastError = error;
        // If it's a "stream not writeable" error, wait and retry
        if (
          error.message?.includes('writeable') ||
          error.message?.includes('offline')
        ) {
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
            continue;
          }
        }
        // For other errors, throw immediately
        throw error;
      }
    }

    throw lastError || new Error('Ping failed after retries');
  }

  getQueue(): Queue | null {
    return this.queue;
  }

  getRedisClient(): Redis | null {
    return this.redisClient;
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.redisClient) {
      return false;
    }

    try {
      // Check if connection is ready
      if (this.redisClient.status !== 'ready') {
        this.logger.warn(`Redis connection status: ${this.redisClient.status}`);
        return false;
      }

      // Use retry logic for ping
      const result = await this.pingWithRetry(this.redisClient, 3);
      return result === 'PONG';
    } catch (error: any) {
      this.logger.error(
        `Redis connection verification failed: ${error.message}`,
      );
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue) {
      await this.queue.close();
      this.logger.log('BullMQ queue closed');
    }

    if (this.redisClient) {
      await this.redisClient.quit();
      this.logger.log('Redis connection closed');
    }
  }
}
