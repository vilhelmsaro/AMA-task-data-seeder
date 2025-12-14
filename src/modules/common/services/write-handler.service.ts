import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Car } from '../../car-seeder/car-seeder.interface';
import { StateManagerService } from './state-manager.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { SqliteManagerService } from './sqlite-manager.service';
import { MetricsService } from './metrics.service';
import { SeederState } from '../enums/state.enum';
import { CircuitBreakerState } from '../enums/circuit-breaker-state.enum';

@Injectable()
export class WriteHandlerService {
  private readonly logger = new Logger(WriteHandlerService.name);
  private queue: Queue | null = null;

  constructor(
    private readonly stateManager: StateManagerService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly sqliteManager: SqliteManagerService,
    private readonly metrics: MetricsService,
  ) {}

  setQueue(queue: Queue): void {
    this.queue = queue;
  }

  async writeCar(car: Car): Promise<void> {
    const currentState = this.stateManager.getState();
    const circuitState = this.circuitBreaker.getState();
    this.logger.debug(
      `[DEBUG] writeCar called - Current state: ${currentState}, Circuit breaker: ${circuitState}`,
    );

    // If circuit breaker is HALF_OPEN, attempt Redis write to test connection
    // This allows recovery even when in SQLITE_MODE
    if (circuitState === CircuitBreakerState.HALF_OPEN) {
      this.logger.debug(
        `[DEBUG] writeCar - Circuit breaker is HALF_OPEN, attempting test write to Redis`,
      );
      await this.writeToRedis(car);
      return;
    }

    if (currentState === SeederState.REDIS_MODE) {
      await this.writeToRedis(car);
    } else {
      this.logger.debug(
        `[DEBUG] writeCar - State is SQLITE_MODE, writing directly to SQLite`,
      );
      await this.writeToSqlite(car);
    }
  }

  private async writeToRedis(car: Car): Promise<void> {
    if (!this.queue) {
      throw new Error('Queue not initialized');
    }

    const circuitState = this.circuitBreaker.getState();
    this.logger.debug(
      `[DEBUG] writeToRedis - Circuit breaker state: ${circuitState}, isOpen: ${this.circuitBreaker.isOpen()}, isHalfOpen: ${this.circuitBreaker.isHalfOpen()}`,
    );

    // Check circuit breaker state
    if (this.circuitBreaker.isOpen()) {
      // Circuit is open, switch to SQLite mode
      this.logger.warn(
        `[DEBUG] writeToRedis - Circuit breaker is OPEN, switching to SQLITE_MODE`,
      );
      this.stateManager.setState(SeederState.SQLITE_MODE);
      await this.writeToSqlite(car);
      return;
    }

    // If half-open, this is a test write
    const isTestWrite = this.circuitBreaker.isHalfOpen();
    this.logger.debug(
      `[DEBUG] writeToRedis - Attempting Redis write, isTestWrite: ${isTestWrite}`,
    );

    try {
      // Direct write to BullMQ
      // With enableOfflineQueue: false, this will throw immediately if Redis is down
      this.logger.debug(`[DEBUG] writeToRedis - Calling queue.add()`);

      const job = await this.queue.add('car', car, {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      });

      const jobId = job?.id;
      this.logger.debug(
        `[DEBUG] writeToRedis - queue.add() succeeded, job ID: ${jobId}`,
      );

      // Success - record it in circuit breaker
      this.circuitBreaker.recordSuccess();
      this.logger.debug(
        `[DEBUG] writeToRedis - Recorded success in circuit breaker`,
      );

      // If we're in SQLITE_MODE and Redis write succeeded, switch back to REDIS_MODE
      // This handles both test writes (half-open) and normal recovery scenarios
      if (this.stateManager.isSqliteMode()) {
        const previousState = this.stateManager.getState();
        this.logger.log('Redis write succeeded, switching to REDIS_MODE');
        this.stateManager.setState(SeederState.REDIS_MODE);
        // Record state transition back to Redis
        this.metrics.recordStateTransitionToRedis(previousState);
      } else if (isTestWrite) {
        this.logger.log('Test write succeeded, circuit breaker closed');
      }
    } catch (error: any) {
      this.logger.debug(
        `[DEBUG] writeToRedis - ERROR IN GENERAL ! ${error},,,,,,,,,,,,,,,, Error caught: ${error.message}, code: ${error.code}, stack: ${error.stack?.substring(0, 200)}`,
      );

      // Error occurred - classify and handle
      const isRedisError = this.isRedisConnectionError(error);
      this.logger.debug(
        `[DEBUG] writeToRedis - Error classification: isRedisConnectionError=${isRedisError}`,
      );

      if (isRedisError) {
        // Redis connection error - record failure
        const failureCountBefore = this.getFailureCount();
        this.circuitBreaker.recordFailure();
        const failureCountAfter = this.getFailureCount();
        const circuitStateAfter = this.circuitBreaker.getState();

        this.logger.debug(
          `[DEBUG] writeToRedis - Recorded failure. Count: ${failureCountBefore} → ${failureCountAfter}, Circuit state: ${circuitStateAfter}`,
        );

        // If circuit is now open, switch to SQLite mode
        if (this.circuitBreaker.isOpen()) {
          const currentStateBefore = this.stateManager.getState();

          // Record master failure and state transition
          if (currentStateBefore === SeederState.REDIS_MODE) {
            this.metrics.recordMasterFailure(error.message);
          }

          this.logger.warn(
            `[DEBUG] writeToRedis - Circuit breaker OPENED! Switching from ${currentStateBefore} to SQLITE_MODE. Error: ${error.message}`,
          );
          this.stateManager.setState(SeederState.SQLITE_MODE);
          const currentStateAfter = this.stateManager.getState();
          this.logger.debug(
            `[DEBUG] writeToRedis - State changed: ${currentStateBefore} → ${currentStateAfter}`,
          );

          // Record state transition to SQLite
          this.metrics.recordStateTransitionToSqlite(currentStateBefore);
        } else {
          this.logger.debug(
            `[DEBUG] writeToRedis - Circuit breaker NOT open yet (state: ${circuitStateAfter}), staying in REDIS_MODE`,
          );
        }

        // Save to SQLite as fallback
        this.logger.debug(
          `[DEBUG] writeToRedis - Saving to SQLite as fallback`,
        );
        this.metrics.incrementSqliteFallbackCount();
        await this.writeToSqlite(car);
      } else {
        // Other errors (validation, queue full, etc.)
        // For now, log and skip - specific handling can be added later
        this.logger.error(
          `[DEBUG] writeToRedis - Non-Redis error writing car to queue: ${error.message}, code: ${error.code}`,
        );
        // TODO: Add specific handling for different error types:
        // - Validation errors: validate data before writing
        // - Queue full errors: implement backpressure or increase queue size
        // - Other application-level errors: implement appropriate retry/fallback
        throw error;
      }
    }
  }

  private async writeToSqlite(car: Car): Promise<void> {
    const maxRetries = 2;
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.sqliteManager.saveCar(car);
        // Success - return immediately
        if (attempt > 0) {
          this.logger.log(
            `Successfully saved car to SQLite after ${attempt} retry(ies)`,
          );
        }
        return;
      } catch (error: any) {
        lastError = error;
        this.logger.warn(
          `Failed to save car to SQLite (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}`,
        );

        // If this is not the last attempt, wait before retrying
        if (attempt < maxRetries) {
          // Exponential backoff: 100ms, 200ms
          const delayMs = 100 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    // All retries exhausted
    this.logger.error(
      `Failed to save car to SQLite after ${maxRetries + 1} attempts. Car data will be lost.`,
    );
    throw lastError;
  }

  private isRedisConnectionError(error: any): boolean {
    if (!error) {
      this.logger.debug(
        `[DEBUG] isRedisConnectionError - Error is null/undefined`,
      );
      return false;
    }

    const errorMessage = error.message?.toLowerCase() || '';
    const errorCode = error.code || '';

    this.logger.debug(
      `[DEBUG] isRedisConnectionError - Checking error. Code: "${errorCode}", Message: "${errorMessage}"`,
    );

    // Check for connection error codes (including nested errors)
    const connectionErrorCodes = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ECONNRESET',
      'EPIPE',
    ];

    // Check primary error code
    if (connectionErrorCodes.includes(errorCode)) {
      this.logger.debug(
        `[DEBUG] isRedisConnectionError - MATCHED error code: ${errorCode}`,
      );
      this.logger.warn(
        `Connection Error is redis connection error! : ${error.message}`,
      );
      return true;
    }

    // Check nested errors (ioredis may wrap the actual connection error)
    // Check error.cause, error.lastError, error.originalError, etc.
    const nestedError = error.cause || error.lastError || error.originalError;
    if (nestedError) {
      const nestedCode = nestedError.code || '';
      const nestedMessage = nestedError.message?.toLowerCase() || '';

      this.logger.debug(
        `[DEBUG] isRedisConnectionError - Checking nested error. Code: "${nestedCode}", Message: "${nestedMessage}"`,
      );

      if (connectionErrorCodes.includes(nestedCode)) {
        this.logger.debug(
          `[DEBUG] isRedisConnectionError - MATCHED nested error code: ${nestedCode}`,
        );
        this.logger.warn(
          `Connection Error is redis connection error! (nested): ${nestedError.message}`,
        );
        return true;
      }
    }

    // Check for Redis-specific connection error messages
    const connectionErrorMessages = [
      'connection lost',
      'connection closed',
      'redis connection failed',
      'connect econnrefused',
      'connect etimedout',
      // Add patterns for enableOfflineQueue errors
      "stream isn't writeable",
      'stream is not writeable',
      'enableofflinequeue',
      'offline queue',
      'writeable',
      // Check for DNS/host resolution errors in message
      'getaddrinfo',
      'enotfound',
    ];

    for (const msg of connectionErrorMessages) {
      if (errorMessage.includes(msg)) {
        this.logger.debug(
          `[DEBUG] isRedisConnectionError - MATCHED error message pattern: "${msg}"`,
        );
        return true;
      }
    }

    // Check nested error messages
    if (nestedError) {
      const nestedMessage = nestedError.message?.toLowerCase() || '';
      for (const msg of connectionErrorMessages) {
        if (nestedMessage.includes(msg)) {
          this.logger.debug(
            `[DEBUG] isRedisConnectionError - MATCHED nested error message pattern: "${msg}"`,
          );
          return true;
        }
      }
    }

    // Check error stack trace for connection-related errors
    const errorStack = error.stack?.toLowerCase() || '';
    if (
      errorStack.includes('getaddrinfo') ||
      errorStack.includes('enotfound') ||
      errorStack.includes('econnrefused') ||
      errorStack.includes('etimedout')
    ) {
      this.logger.debug(
        `[DEBUG] isRedisConnectionError - MATCHED error in stack trace`,
      );
      return true;
    }

    this.logger.debug(
      `[DEBUG] isRedisConnectionError - NOT a Redis connection error`,
    );
    return false;
  }

  // Helper method to get failure count (for debugging)
  private getFailureCount(): number {
    return this.circuitBreaker.getFailureCount();
  }
}
