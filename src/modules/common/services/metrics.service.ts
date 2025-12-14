import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

interface FailoverEvent {
  eventId: string;
  timestamp: string;
  eventType:
    | 'MASTER_FAILURE_DETECTED'
    | 'SENTINEL_PROMOTION'
    | 'STATE_TRANSITION_TO_SQLITE'
    | 'STATE_TRANSITION_TO_REDIS'
    | 'RECOVERY_STARTED'
    | 'RECOVERY_COMPLETED';
  details: {
    previousState?: string;
    newState?: string;
    errorMessage?: string;
    sqliteFallbackCount?: number;
    durationMs?: number;
    [key: string]: any;
  };
}

interface FailoverSession {
  sessionId: string;
  masterFailureDetectedAt: number | null;
  sentinelPromotionDetectedAt: number | null;
  stateTransitionToSqliteAt: number | null;
  stateTransitionToRedisAt: number | null;
  recoveryStartedAt: number | null;
  recoveryCompletedAt: number | null;
  sqliteFallbackCount: number;
  isActive: boolean;
}

@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  private logFilePath: string;
  private logStream: fs.WriteStream | null = null;
  private currentSession: FailoverSession | null = null;
  private sqliteFallbackCount = 0;
  private totalFailoverSessions = 0;

  constructor() {
    const logDir = process.env.METRICS_LOG_DIR || './logs';
    const logFileName = `failover-metrics-${new Date().toISOString().split('T')[0]}.log`;
    this.logFilePath = path.join(logDir, logFileName);

    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  onModuleInit(): void {
    // Open log file stream
    this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
    this.logger.log(
      `Metrics logging initialized. Log file: ${this.logFilePath}`,
    );
    this.logEvent({
      eventType: 'STATE_TRANSITION_TO_REDIS',
      details: {
        message: 'Service started',
        newState: 'REDIS_MODE',
      },
    });
  }

  onModuleDestroy(): Promise<void> {
    return new Promise((resolve) => {
      if (this.logStream) {
        this.logStream.end(() => {
          this.logger.log('Metrics log stream closed');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Record when master failure is detected
   */
  recordMasterFailure(errorMessage: string): void {
    const now = Date.now();

    // Start new failover session if not already active
    if (!this.currentSession || !this.currentSession.isActive) {
      this.totalFailoverSessions++;
      this.currentSession = {
        sessionId: `failover-${this.totalFailoverSessions}-${now}`,
        masterFailureDetectedAt: now,
        sentinelPromotionDetectedAt: null,
        stateTransitionToSqliteAt: null,
        stateTransitionToRedisAt: null,
        recoveryStartedAt: null,
        recoveryCompletedAt: null,
        sqliteFallbackCount: 0,
        isActive: true,
      };
      this.sqliteFallbackCount = 0; // Reset counter for this session
    } else {
      // Update existing session
      this.currentSession.masterFailureDetectedAt = now;
    }

    this.logEvent({
      eventType: 'MASTER_FAILURE_DETECTED',
      details: {
        sessionId: this.currentSession.sessionId,
        errorMessage,
        message: 'Master Redis failure detected',
      },
    });
  }

  /**
   * Record when Sentinel promotes slave to master
   */
  recordSentinelPromotion(): void {
    // Create session if missing (e.g., service restarted during failover)
    if (!this.currentSession || !this.currentSession.isActive) {
      this.logger.warn(
        'Sentinel promotion detected but no active failover session - creating incomplete session',
      );
      const now = Date.now();
      this.totalFailoverSessions++;
      this.currentSession = {
        sessionId: `failover-${this.totalFailoverSessions}-${now}`,
        masterFailureDetectedAt: null, // Unknown - session created late
        sentinelPromotionDetectedAt: now,
        stateTransitionToSqliteAt: null,
        stateTransitionToRedisAt: null,
        recoveryStartedAt: null,
        recoveryCompletedAt: null,
        sqliteFallbackCount: this.sqliteFallbackCount,
        isActive: true,
      };
    }

    const now = Date.now();
    this.currentSession.sentinelPromotionDetectedAt = now;

    const duration = this.currentSession.masterFailureDetectedAt
      ? now - this.currentSession.masterFailureDetectedAt
      : undefined;

    this.logEvent({
      eventType: 'SENTINEL_PROMOTION',
      details: {
        sessionId: this.currentSession.sessionId,
        durationMs: duration,
        durationFormatted: duration ? this.formatDuration(duration) : 'N/A',
        message: 'Sentinel promoted replica to master',
      },
    });
  }

  /**
   * Record state transition to SQLite mode
   */
  recordStateTransitionToSqlite(previousState: string): void {
    const now = Date.now();

    if (!this.currentSession || !this.currentSession.isActive) {
      // Start new session if not already active
      this.totalFailoverSessions++;
      this.currentSession = {
        sessionId: `failover-${this.totalFailoverSessions}-${now}`,
        masterFailureDetectedAt: now,
        sentinelPromotionDetectedAt: null,
        stateTransitionToSqliteAt: now,
        stateTransitionToRedisAt: null,
        recoveryStartedAt: null,
        recoveryCompletedAt: null,
        sqliteFallbackCount: 0,
        isActive: true,
      };
      this.sqliteFallbackCount = 0;
    } else {
      this.currentSession.stateTransitionToSqliteAt = now;
    }

    const duration = this.currentSession.masterFailureDetectedAt
      ? now - this.currentSession.masterFailureDetectedAt
      : undefined;

    this.logEvent({
      eventType: 'STATE_TRANSITION_TO_SQLITE',
      details: {
        sessionId: this.currentSession.sessionId,
        previousState,
        newState: 'SQLITE_MODE',
        durationMs: duration,
        durationFormatted: duration ? this.formatDuration(duration) : 'N/A',
        message: 'State transitioned to SQLite mode',
      },
    });
  }

  /**
   * Record state transition back to Redis mode
   */
  recordStateTransitionToRedis(previousState: string): void {
    // Create session if missing (e.g., service restarted during failover)
    // This ensures we don't lose metrics, even if session is incomplete
    if (!this.currentSession || !this.currentSession.isActive) {
      this.logger.warn(
        'State transition to Redis but no active failover session - creating incomplete session',
      );
      const now = Date.now();
      this.totalFailoverSessions++;
      this.currentSession = {
        sessionId: `failover-${this.totalFailoverSessions}-${now}`,
        masterFailureDetectedAt: null, // Unknown - session created late
        sentinelPromotionDetectedAt: null,
        stateTransitionToSqliteAt: null, // Unknown
        stateTransitionToRedisAt: now,
        recoveryStartedAt: null,
        recoveryCompletedAt: null,
        sqliteFallbackCount: this.sqliteFallbackCount,
        isActive: true,
      };
    }

    const now = Date.now();
    this.currentSession.stateTransitionToRedisAt = now;

    const durations = {
      masterFailureToStateTransition: this.currentSession
        .masterFailureDetectedAt
        ? now - this.currentSession.masterFailureDetectedAt
        : null,
      sentinelPromotionToStateTransition: this.currentSession
        .sentinelPromotionDetectedAt
        ? now - this.currentSession.sentinelPromotionDetectedAt
        : null,
      sqliteToRedis: this.currentSession.stateTransitionToSqliteAt
        ? now - this.currentSession.stateTransitionToSqliteAt
        : null,
    };

    this.logEvent({
      eventType: 'STATE_TRANSITION_TO_REDIS',
      details: {
        sessionId: this.currentSession.sessionId,
        previousState,
        newState: 'REDIS_MODE',
        sqliteFallbackCount: this.currentSession.sqliteFallbackCount,
        durations,
        durationFormatted: {
          masterFailureToStateTransition:
            durations.masterFailureToStateTransition
              ? this.formatDuration(durations.masterFailureToStateTransition)
              : 'N/A',
          sentinelPromotionToStateTransition:
            durations.sentinelPromotionToStateTransition
              ? this.formatDuration(
                  durations.sentinelPromotionToStateTransition,
                )
              : 'N/A',
          sqliteToRedis: durations.sqliteToRedis
            ? this.formatDuration(durations.sqliteToRedis)
            : 'N/A',
        },
        message: 'State transitioned back to Redis mode',
      },
    });

    // Mark session as completed
    this.currentSession.isActive = false;
    this.currentSession = null;
  }

  /**
   * Increment SQLite fallback counter
   */
  incrementSqliteFallbackCount(): void {
    this.sqliteFallbackCount++;
    if (this.currentSession) {
      this.currentSession.sqliteFallbackCount = this.sqliteFallbackCount;
    }
  }

  /**
   * Get current SQLite fallback count
   */
  getSqliteFallbackCount(): number {
    return this.sqliteFallbackCount;
  }

  /**
   * Record recovery started
   */
  recordRecoveryStarted(): void {
    if (!this.currentSession || !this.currentSession.isActive) {
      return;
    }

    const now = Date.now();
    this.currentSession.recoveryStartedAt = now;

    this.logEvent({
      eventType: 'RECOVERY_STARTED',
      details: {
        sessionId: this.currentSession.sessionId,
        sqliteFallbackCount: this.currentSession.sqliteFallbackCount,
        message: 'Recovery process started',
      },
    });
  }

  /**
   * Record recovery completed
   */
  recordRecoveryCompleted(
    entriesRecovered: number,
    entriesFailed?: number,
  ): void {
    if (!this.currentSession || !this.currentSession.isActive) {
      return;
    }

    const now = Date.now();
    this.currentSession.recoveryCompletedAt = now;

    const duration = this.currentSession.recoveryStartedAt
      ? now - this.currentSession.recoveryStartedAt
      : undefined;

    const message =
      entriesFailed !== undefined && entriesFailed > 0
        ? `Recovery process completed: ${entriesRecovered} recovered, ${entriesFailed} failed`
        : `Recovery process completed: ${entriesRecovered} recovered`;

    this.logEvent({
      eventType: 'RECOVERY_COMPLETED',
      details: {
        sessionId: this.currentSession.sessionId,
        entriesRecovered,
        entriesFailed,
        durationMs: duration,
        durationFormatted: duration ? this.formatDuration(duration) : 'N/A',
        message,
      },
    });
  }

  /**
   * Log an event to file
   */
  private logEvent(event: Omit<FailoverEvent, 'eventId' | 'timestamp'>): void {
    const failoverEvent: FailoverEvent = {
      eventId: `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      ...event,
    };

    const logLine = JSON.stringify(failoverEvent, null, 2);

    // Write to file
    if (this.logStream) {
      this.logStream.write(logLine + '\n\n');
    }

    // Also log to console with appropriate level
    const logMessage = `[${failoverEvent.eventType}] ${event.details.message || 'Event occurred'}`;
    if (
      event.eventType.includes('FAILURE') ||
      event.eventType.includes('SQLITE')
    ) {
      this.logger.warn(logMessage);
    } else {
      this.logger.log(logMessage);
    }

    // Log detailed metrics
    if (event.details.durationMs !== undefined) {
      this.logger.log(
        `  Duration: ${event.details.durationFormatted || event.details.durationMs}ms`,
      );
    }
    if (event.details.sqliteFallbackCount !== undefined) {
      this.logger.log(
        `  SQLite Fallback Count: ${event.details.sqliteFallbackCount}`,
      );
    }
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(2)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(2);
      return `${minutes}m ${seconds}s`;
    }
  }

  /**
   * Get current session summary
   */
  getCurrentSessionSummary(): any {
    if (!this.currentSession) {
      return null;
    }

    const now = Date.now();
    return {
      sessionId: this.currentSession.sessionId,
      isActive: this.currentSession.isActive,
      sqliteFallbackCount: this.currentSession.sqliteFallbackCount,
      durations: {
        sinceMasterFailure: this.currentSession.masterFailureDetectedAt
          ? now - this.currentSession.masterFailureDetectedAt
          : null,
        sinceSentinelPromotion: this.currentSession.sentinelPromotionDetectedAt
          ? now - this.currentSession.sentinelPromotionDetectedAt
          : null,
        sinceStateTransitionToSqlite: this.currentSession
          .stateTransitionToSqliteAt
          ? now - this.currentSession.stateTransitionToSqliteAt
          : null,
      },
    };
  }
}
