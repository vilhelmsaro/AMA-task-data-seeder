import { Injectable, Logger } from '@nestjs/common';
import { CircuitBreakerState } from '../enums/circuit-breaker-state.enum';

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failureCount = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private cooldownTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.failureThreshold =
      parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD || '5', 10) || 5;
    this.cooldownMs =
      parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS || '2000', 10) || 2000;
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  isClosed(): boolean {
    return this.state === CircuitBreakerState.CLOSED;
  }

  isOpen(): boolean {
    return this.state === CircuitBreakerState.OPEN;
  }

  isHalfOpen(): boolean {
    return this.state === CircuitBreakerState.HALF_OPEN;
  }

  recordSuccess(): void {
    const previousState = this.state;
    const previousCount = this.failureCount;

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.logger.log(
        `[DEBUG] Circuit breaker: HALF_OPEN → CLOSED (test succeeded)`,
      );
      this.state = CircuitBreakerState.CLOSED;
      this.failureCount = 0;
      this.clearCooldownTimer();
    } else if (this.state === CircuitBreakerState.CLOSED) {
      // Reset failure count on success
      if (this.failureCount > 0) {
        this.logger.debug(
          `[DEBUG] Circuit breaker: Resetting failure count from ${this.failureCount} to 0 (success in CLOSED state)`,
        );
      }
      this.failureCount = 0;
    }

    this.logger.debug(
      `[DEBUG] CircuitBreaker.recordSuccess - State: ${previousState} → ${this.state}, Count: ${previousCount} → ${this.failureCount}`,
    );
  }

  recordFailure(): void {
    const previousCount = this.failureCount;
    const previousState = this.state;
    this.failureCount++;

    this.logger.debug(
      `[DEBUG] CircuitBreaker.recordFailure - Count: ${previousCount} → ${this.failureCount}/${this.failureThreshold}, State: ${previousState}`,
    );

    if (this.state === CircuitBreakerState.CLOSED) {
      if (this.failureCount >= this.failureThreshold) {
        this.logger.warn(
          `[DEBUG] Circuit breaker: CLOSED → OPEN (${this.failureCount} failures >= threshold ${this.failureThreshold})`,
        );
        this.open();
      } else {
        this.logger.debug(
          `[DEBUG] Circuit breaker: Still CLOSED (${this.failureCount}/${this.failureThreshold} failures)`,
        );
      }
    } else if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.logger.warn(
        `[DEBUG] Circuit breaker: HALF_OPEN → OPEN (test failed)`,
      );
      this.open();
    }
  }

  private open(): void {
    const previousState = this.state;
    this.state = CircuitBreakerState.OPEN;
    this.logger.debug(
      `[DEBUG] CircuitBreaker.open - State changed: ${previousState} → ${this.state}`,
    );
    this.startCooldown();
  }

  private startCooldown(): void {
    this.clearCooldownTimer();
    this.cooldownTimer = setTimeout(() => {
      this.logger.log('Circuit breaker: OPEN → HALF_OPEN (cooldown expired)');
      this.state = CircuitBreakerState.HALF_OPEN;
      this.cooldownTimer = null;
    }, this.cooldownMs);
  }

  private clearCooldownTimer(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  reset(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.failureCount = 0;
    this.clearCooldownTimer();
  }

  /**
   * Transition to HALF_OPEN state for testing.
   * This is used when the service appears to be restored (e.g., connection re-established).
   * The next operation will test if the service is truly stable.
   */
  transitionToHalfOpen(): void {
    const previousState = this.state;
    this.clearCooldownTimer(); // Clear any pending cooldown timer
    this.state = CircuitBreakerState.HALF_OPEN;
    this.failureCount = 0; // Reset failure count for the test
    this.logger.log(
      `Circuit breaker: ${previousState} → HALF_OPEN (service appears restored, testing stability)`,
    );
  }
}
