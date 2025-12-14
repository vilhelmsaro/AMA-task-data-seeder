import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { SqliteManagerService } from './sqlite-manager.service';
import { StateManagerService } from './state-manager.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { MetricsService } from './metrics.service';

@Injectable()
export class RecoveryManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecoveryManagerService.name);
  private queue: Queue | null = null;
  private redisClient: Redis | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private isRecovering = false;
  private lastRecoveryAttempt = 0;
  private readonly chunkSize: number;
  private readonly cooldownMs: number;
  private readonly checkIntervalMs: number;
  // Instance ID for future multi-instance support
  // Format: process.pid-timestamp or hostname-process.pid
  // TODO: Implement instance ID generation for multi-instance support
  private readonly instanceId: string;
  private sentinelClients: Redis[] = [];
  private sentinelSubscriber: Redis | null = null;
  private sentinelMasterName: string = 'mymaster';
  private isHandlingReconnection = false;
  private lastReconnectionTime = 0;
  private readonly RECONNECTION_COOLDOWN_MS = 2000;

  constructor(
    private readonly sqliteManager: SqliteManagerService,
    private readonly stateManager: StateManagerService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly metrics: MetricsService,
  ) {
    this.chunkSize =
      parseInt(process.env.RECOVERY_CHUNK_SIZE || '50', 10) || 50;
    this.cooldownMs =
      parseInt(process.env.RECOVERY_COOLDOWN_MS || '10000', 10) || 10000;
    this.checkIntervalMs =
      parseInt(process.env.RECOVERY_CHECK_INTERVAL_MS || '5000', 10) || 5000;
    this.instanceId = `instance-${process.pid}-${Date.now()}`;
  }

  setQueue(queue: Queue): void {
    this.queue = queue;
  }

  setRedisClient(client: Redis): void {
    this.redisClient = client;
    this.initializeSentinelClients();
    this.setupSentinelEventSubscription();
  }

  /**
   * Initialize Sentinel clients to query current master directly
   */
  private initializeSentinelClients(): void {
    const useSentinel = process.env.REDIS_USE_SENTINEL === 'true';
    const sentinelHosts = process.env.REDIS_SENTINEL_HOSTS;
    this.sentinelMasterName =
      process.env.REDIS_SENTINEL_MASTER_NAME || 'mymaster';

    if (!useSentinel || !sentinelHosts) {
      return;
    }

    // Parse Sentinel hosts
    const sentinels = sentinelHosts.split(',').map((hostPort) => {
      const [host, port] = hostPort.trim().split(':');
      return {
        host: host || 'localhost',
        port: parseInt(port || '26379', 10),
      };
    });

    // Create Sentinel clients for querying master address
    this.sentinelClients = sentinels.map((sentinel) => {
      const client = new Redis({
        host: sentinel.host,
        port: sentinel.port,
        lazyConnect: true,
        retryStrategy: () => null,
      });
      return client;
    });
  }

  /**
   * Subscribe to Sentinel +switch-master events for immediate failover detection
   */
  private async setupSentinelEventSubscription(): Promise<void> {
    if (this.sentinelClients.length === 0) {
      return;
    }

    try {
      // Use first Sentinel for subscription
      const firstSentinel = this.sentinelClients[0];
      this.sentinelSubscriber = new Redis({
        host: firstSentinel.options.host,
        port: firstSentinel.options.port,
        lazyConnect: true,
        retryStrategy: () => null,
      });

      await this.sentinelSubscriber.connect();

      // Subscribe to all Sentinel events (pattern match)
      await this.sentinelSubscriber.psubscribe('*');

      this.sentinelSubscriber.on(
        'pmessage',
        async (pattern, channel, message) => {
          // Listen for +switch-master events
          if (channel === '+switch-master') {
            await this.handleSentinelSwitchMasterEvent(message);
          }
        },
      );

      this.logger.log('Subscribed to Sentinel +switch-master events');
    } catch (error: any) {
      this.logger.warn(
        `Failed to subscribe to Sentinel events: ${error.message}`,
      );
      // Continue without event subscription - will fall back to polling
    }
  }

  /**
   * Handle Sentinel +switch-master event
   * Format: +switch-master <master-name> <old-ip> <old-port> <new-ip> <new-port>
   */
  private async handleSentinelSwitchMasterEvent(
    message: string,
  ): Promise<void> {
    const parts = message.split(' ');
    if (parts.length < 5 || parts[0] !== this.sentinelMasterName) {
      return;
    }

    const newMaster = {
      host: parts[3],
      port: parseInt(parts[4], 10),
    };

    const now = Date.now();

    // Idempotency check
    if (this.isHandlingReconnection) {
      return;
    }

    // Cooldown check
    if (now - this.lastReconnectionTime < this.RECONNECTION_COOLDOWN_MS) {
      return;
    }

    this.isHandlingReconnection = true;
    this.lastReconnectionTime = now;

    this.logger.log(
      `[Sentinel] Failover detected: New master is ${newMaster.host}:${newMaster.port}`,
    );

    // Force reconnection to new master
    await this.forceReconnection();

    this.isHandlingReconnection = false;
  }

  onModuleInit(): void {
    // Start periodic health check
    this.startHealthCheck();
  }

  setupConnectionListenersIfNeeded(): void {
    // Setup connection event listeners if client is available and listeners not already set up
    if (!this.redisClient) {
      return;
    }

    // Check if any of our listeners are already attached to avoid duplicates
    const hasListeners =
      this.redisClient.listenerCount('reconnecting') > 0 ||
      this.redisClient.listenerCount('ready') > 0 ||
      this.redisClient.listenerCount('error') > 0;

    if (!hasListeners) {
      this.setupConnectionListeners();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHealthCheck();

    // Close Sentinel subscriber
    if (this.sentinelSubscriber) {
      try {
        await this.sentinelSubscriber.quit();
      } catch (e) {
        // Ignore errors during cleanup
      }
      this.sentinelSubscriber = null;
    }

    // Close Sentinel clients
    for (const sentinelClient of this.sentinelClients) {
      try {
        await sentinelClient.quit();
      } catch (e) {
        // Ignore errors during cleanup
      }
    }
    this.sentinelClients = [];
  }

  private setupConnectionListeners(): void {
    if (!this.redisClient) {
      return;
    }

    this.redisClient.on('reconnecting', (delay: number) => {
      this.logger.log(`[ioredis] Reconnecting in ${delay}ms`);
    });

    this.redisClient.on('ready', async () => {
      // Idempotency check - skip if Sentinel event already triggered reconnection
      if (this.isHandlingReconnection) {
        return;
      }

      // Backup mechanism - ioredis reconnected automatically
      this.logger.log('[ioredis] Reconnected automatically (backup mechanism)');

      await new Promise((resolve) => setTimeout(resolve, 500));

      const isRedisAvailable = await this.isRedisAvailable();

      if (isRedisAvailable && this.stateManager.isSqliteMode()) {
        this.metrics.recordSentinelPromotion();
        this.circuitBreaker.transitionToHalfOpen();
        this.logger.log('[ioredis] Circuit breaker: OPEN → HALF_OPEN');
        this.triggerRecovery();
      }
    });

    this.redisClient.on('error', (error: any) => {
      const errorMessage = error.message?.toLowerCase() || '';
      if (
        errorMessage.includes('connection') ||
        errorMessage.includes('econnrefused') ||
        errorMessage.includes('etimedout')
      ) {
        this.logger.warn(`[ioredis] Connection error: ${error.message}`);
      }
    });
  }

  private startHealthCheck(): void {
    // Health check is now a backup mechanism - primary detection is via Sentinel events
    // Run less frequently since Sentinel events handle immediate detection
    const runCheck = () => {
      this.checkAndRecover().catch((err) => {
        this.logger.error(`Health check error: ${err.message}`);
      });
    };

    runCheck();

    const scheduleNext = () => {
      this.healthCheckInterval = setTimeout(() => {
        runCheck();
        scheduleNext();
      }, this.checkIntervalMs);
    };

    scheduleNext();
  }

  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private async checkAndRecover(): Promise<void> {
    // Health check is now a backup mechanism - primary detection is via Sentinel events
    // Only check for pending entries and basic Redis availability

    if (this.stateManager.isSqliteMode() && this.circuitBreaker.isOpen()) {
      const isRedisWritable = await this.testRedisWrite();
      if (isRedisWritable) {
        this.metrics.recordSentinelPromotion();
        this.circuitBreaker.transitionToHalfOpen();
        this.logger.log(
          '[Health Check] Redis available - Circuit breaker: OPEN → HALF_OPEN',
        );
      }
    }

    const pendingCount = await this.sqliteManager.getPendingCount();
    if (pendingCount > 0) {
      this.logger.log(
        `[Health Check] Found ${pendingCount} pending entries, triggering recovery`,
      );
      await this.triggerRecovery();
    }
  }

  /**
   * Force ioredis to reconnect to the current master
   */
  private async forceReconnection(): Promise<void> {
    if (!this.redisClient) {
      return;
    }

    try {
      await this.redisClient.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await this.redisClient.connect();

      // Wait for connection to stabilize
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const writeTest = await this.testRedisWrite();
      if (writeTest) {
        this.logger.log('[Reconnection] Successfully connected to new master');

        if (this.stateManager.isSqliteMode()) {
          this.metrics.recordSentinelPromotion();
          this.circuitBreaker.transitionToHalfOpen();
          this.logger.log('[Reconnection] Circuit breaker: OPEN → HALF_OPEN');
          this.triggerRecovery();
        }
      } else {
        this.logger.warn('[Reconnection] Connected but write test failed');
      }
    } catch (error: any) {
      this.logger.warn(`[Reconnection] Failed: ${error.message}`);
    }
  }

  private async testRedisWrite(): Promise<boolean> {
    if (!this.queue) {
      return false;
    }

    try {
      await Promise.race([
        this.queue.add(
          'health-check-test',
          { test: true },
          {
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Test write timeout')), 3000),
        ),
      ]);
      return true;
    } catch (error: any) {
      return false;
    }
  }

  async triggerRecovery(): Promise<void> {
    if (this.isRecovering) {
      return;
    }

    const now = Date.now();
    if (now - this.lastRecoveryAttempt < this.cooldownMs) {
      return;
    }

    this.lastRecoveryAttempt = now;

    const isRedisAvailable = await this.isRedisAvailable();
    if (!isRedisAvailable) {
      return;
    }

    this.isRecovering = true;
    this.metrics.recordRecoveryStarted();

    try {
      const result = await this.recoverPendingEntries();
      this.logger.log(
        `[Recovery] Completed: ${result.recovered} entries recovered, ${result.failed} entries failed`,
      );
      this.metrics.recordRecoveryCompleted(
        result.recovered,
        result.failed > 0 ? result.failed : undefined,
      );
    } catch (error: any) {
      this.logger.error(`[Recovery] Failed: ${error.message}`);
      // If error occurred, we don't know how many failed, so pass 0 for recovered
      // and undefined for failed (metrics will handle it)
      this.metrics.recordRecoveryCompleted(0);
    } finally {
      this.isRecovering = false;
    }
  }

  private async recoverPendingEntries(): Promise<{
    recovered: number;
    failed: number;
  }> {
    if (!this.queue) {
      throw new Error('Queue not initialized');
    }

    const staleCount = await this.sqliteManager.cleanupStaleRecoveries(
      5 * 60 * 1000,
    );
    if (staleCount > 0) {
      this.logger.log(
        `[Recovery] Cleaned up ${staleCount} stale recovery entries`,
      );
    }

    let hasMore = true;
    let totalRecovered = 0;
    let totalFailed = 0;

    while (hasMore) {
      const carsToRecover = await this.sqliteManager.getAndMarkPendingCars(
        this.chunkSize,
        this.instanceId,
      );

      if (carsToRecover.length === 0) {
        hasMore = false;
        break;
      }

      const isRedisAvailable = await this.isRedisAvailable();
      if (!isRedisAvailable) {
        const carIds = carsToRecover.map((car) => car.id);
        this.logger.warn(
          `[Recovery] Redis unavailable: ${carIds.length} cars need recovery but cannot proceed. Marking cars as PENDING in SQLite.`,
        );
        await this.sqliteManager.markCarsAsPending(carIds);
        totalFailed += carIds.length;
        break;
      }

      try {
        const successfulEntries: Array<{ carId: string; jobId: string }> = [];
        const failedCarIds: string[] = [];

        for (const car of carsToRecover) {
          try {
            const carData = {
              normalizedMake: car.normalized_make,
              normalizedModel: car.normalized_model,
              year: car.year,
              price: car.price,
              location: car.location,
            };

            const job = await this.queue.add('car', carData, {
              attempts: 3,
              backoff: {
                type: 'exponential',
                delay: 2000,
              },
            });

            successfulEntries.push({
              carId: car.id,
              jobId: job.id || '',
            });
          } catch (error: any) {
            // Individual car failed, but continue with others
            failedCarIds.push(car.id);
            this.logger.warn(
              `[Recovery] Failed to add car ${car.id} to queue: ${error.message}`,
            );
          }
        }

        // Mark successful ones as sent
        if (successfulEntries.length > 0) {
          const successfulIds = successfulEntries.map((e) => e.carId);
          const successfulJobIds = successfulEntries.map((e) => e.jobId);
          await this.sqliteManager.markCarsAsSent(
            successfulIds,
            successfulJobIds,
          );
          totalRecovered += successfulEntries.length;
        }

        // Mark failed ones as pending
        if (failedCarIds.length > 0) {
          await this.sqliteManager.markCarsAsPending(failedCarIds);
          totalFailed += failedCarIds.length;
        }
      } catch (error: any) {
        // Error occurred during batch processing
        const carIds = carsToRecover.map((car) => car.id);
        this.logger.error(
          `[Recovery] Error during batch recovery: ${error.message}. Marking ${carIds.length} cars as PENDING.`,
        );
        await this.sqliteManager.markCarsAsPending(carIds);
        totalFailed += carIds.length;
        break;
      }
    }

    this.logger.log(
      `[Recovery] Recovery summary: Recovered: ${totalRecovered}, Failed: ${totalFailed}`,
    );

    return { recovered: totalRecovered, failed: totalFailed };
  }

  private async isRedisAvailable(): Promise<boolean> {
    if (!this.redisClient) {
      return false;
    }

    // Check circuit breaker state first - if OPEN, don't even attempt writes
    // This is more efficient and makes the intent explicit
    if (this.circuitBreaker.isOpen()) {
      this.logger.debug(
        '[Redis Availability] Circuit breaker is OPEN, Redis not available',
      );
      return false;
    }

    try {
      const pingPromise = this.redisClient.ping();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Ping timeout')), 2000),
      );

      await Promise.race([pingPromise, timeoutPromise]);
    } catch (error: any) {
      // Ping failed, try write test
      this.logger.log(
        "[Redis Availability] Ping failed, will attempt write test to 'car-seeder-queue' queue",
      );
    }

    if (this.queue) {
      return await this.testRedisWrite();
    }

    return false;
  }
}
