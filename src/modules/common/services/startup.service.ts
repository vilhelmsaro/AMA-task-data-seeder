import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { SqliteManagerService } from './sqlite-manager.service';
import { BullmqService } from './bullmq.service';
import { WriteHandlerService } from './write-handler.service';
import { RecoveryManagerService } from './recovery-manager.service';
import { StateManagerService } from './state-manager.service';
import { SeederState } from '../enums/state.enum';

@Injectable()
export class StartupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StartupService.name);

  constructor(
    private readonly sqliteManager: SqliteManagerService,
    private readonly bullmqService: BullmqService,
    private readonly writeHandler: WriteHandlerService,
    private readonly recoveryManager: RecoveryManagerService,
    private readonly stateManager: StateManagerService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // Step 1: Initialize SQLite
      this.logger.log('Initializing SQLite database...');
      await this.sqliteManager.initialize();
      this.logger.log('SQLite database initialized');

      // Step 2: Connect to Redis and initialize BullMQ
      // initialize() already waits for connection to be ready and verifies with ping
      this.logger.log('Connecting to Redis...');
      const { queue, redisClient } = await this.bullmqService.initialize();
      this.logger.log('Redis connection established and verified');

      // Step 4: Setup services
      this.writeHandler.setQueue(queue);
      this.recoveryManager.setQueue(queue);
      this.recoveryManager.setRedisClient(redisClient);
      this.recoveryManager.setupConnectionListenersIfNeeded();

      // Step 5: Set initial state - Redis is available (we got here, so connection succeeded)
      // State should be REDIS_MODE if Redis is available, regardless of pending entries
      // Recovery will continue in background for any pending entries
      this.logger.log('Redis is available, starting in REDIS_MODE');
      this.stateManager.setState(SeederState.REDIS_MODE);

      // Step 6: Check for pending entries and trigger recovery if needed
      // Recovery runs in background and doesn't affect state
      const pendingCount = await this.sqliteManager.getPendingCount();
      this.logger.log(`Pending entries in SQLite: ${pendingCount}`);

      if (pendingCount > 0) {
        this.logger.log('Triggering recovery for pending entries...');
        // Recovery will run in background, state is already REDIS_MODE
        // so new cars go to Redis while recovery processes SQLite entries
        this.recoveryManager.triggerRecovery().catch((err) => {
          this.logger.error(`Recovery trigger failed: ${err.message}`);
        });
      }
    } catch (error: any) {
      this.logger.error(`Failed to initialize service: ${error.message}`);
      this.logger.error(error.stack);
      throw error;
    }
  }

  onModuleDestroy(): void {
    // Cleanup is handled by individual services via their OnModuleDestroy hooks
    this.logger.log('Startup service destroyed');
  }
}
