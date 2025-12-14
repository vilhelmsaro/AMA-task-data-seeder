import { Module, Global } from '@nestjs/common';
import { StateManagerService } from './services/state-manager.service';
import { CircuitBreakerService } from './services/circuit-breaker.service';
import { SqliteManagerService } from './services/sqlite-manager.service';
import { WriteHandlerService } from './services/write-handler.service';
import { RecoveryManagerService } from './services/recovery-manager.service';
import { BullmqService } from './services/bullmq.service';
import { StartupService } from './services/startup.service';
import { MetricsService } from './services/metrics.service';

@Global()
@Module({
  providers: [
    StartupService,
    StateManagerService,
    CircuitBreakerService,
    SqliteManagerService,
    WriteHandlerService,
    RecoveryManagerService,
    BullmqService,
    MetricsService,
  ],
  exports: [
    StartupService,
    StateManagerService,
    CircuitBreakerService,
    SqliteManagerService,
    WriteHandlerService,
    RecoveryManagerService,
    BullmqService,
    MetricsService,
  ],
})
export class CommonModule {}
