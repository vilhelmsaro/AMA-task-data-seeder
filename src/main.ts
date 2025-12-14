import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { SqliteManagerService } from './modules/common/services/sqlite-manager.service';
import { BullmqService } from './modules/common/services/bullmq.service';
import { CarSeederService } from './modules/car-seeder/car-seeder.service';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  // Get services for graceful shutdown
  const sqliteManager = app.get(SqliteManagerService);
  const bullmqService = app.get(BullmqService);

  try {
    // All initialization is now handled by StartupService via OnModuleInit lifecycle hook
    // This is the proper NestJS approach - services initialize themselves

    // Start HTTP server (initialization happens automatically via OnModuleInit)
    const port = process.env.PORT ?? 3000;
    await app.listen(port);
    logger.log(`Seeder service started on port ${port}`);
    logger.log('Initialization completed via lifecycle hooks');
  } catch (error: any) {
    logger.error(`Failed to start service: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, starting graceful shutdown...`);

    try {
      // Stop generating new cars
      const carSeederService = app.get(CarSeederService);
      if (carSeederService) {
        carSeederService.stopSendingCars();
      }

      // Wait for in-flight operations (10 seconds timeout)
      logger.log('Waiting for in-flight operations...');
      await new Promise((resolve) => setTimeout(resolve, 10000));

      // Flush SQLite batch buffer
      logger.log('Flushing SQLite buffer...');
      await sqliteManager.flushPendingWrites();

      // Close connections
      logger.log('Closing connections...');
      await sqliteManager.close();
      await bullmqService.onModuleDestroy();

      // Close NestJS app
      await app.close();

      logger.log('Graceful shutdown completed');
      process.exit(0);
    } catch (error: any) {
      logger.error(`Error during shutdown: ${error.message}`);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  logger.error(`Bootstrap failed: ${error.message}`);
  logger.error(error.stack);
  process.exit(1);
});
