import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';

import { Car } from './car-seeder.interface';
import {
  makes,
  models,
  locations,
} from '../common/constants/car-details.constants';
import { WriteHandlerService } from '../common/services/write-handler.service';

@Injectable()
export class CarSeederService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CarSeederService.name);
  private generationInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(private readonly writeHandler: WriteHandlerService) {}

  onModuleInit() {
    // Start sending automatically when app starts
    this.startSendingCars();
  }

  onModuleDestroy(): void {
    this.stopSendingCars();
  }

  generateRandomCar(): Car {
    const make = this.randomItem(makes);
    const model = this.randomItem(models);
    const year = this.randomInt(2000, 2024);
    const price = this.randomInt(3000, 80000);
    const location = this.randomItem(locations);

    return {
      normalizedMake: make,
      normalizedModel: model,
      year,
      price,
      location,
    };
  }

  private randomItem<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Sends ~2000 car entities per minute.
   * 1 car every 30ms  →  60,000 / 30 ≈ 2,000
   */
  startSendingCars() {
    const intervalMs =
      parseInt(process.env.CAR_GENERATION_INTERVAL_MS || '30', 10) || 30;

    this.logger.log(
      `Starting car generation: ${intervalMs}ms interval (~${Math.round(60000 / intervalMs)} cars/minute)`,
    );

    this.generationInterval = setInterval(async () => {
      if (this.isShuttingDown) {
        return;
      }

      try {
        // TODO: implement data transfer handling
        const car = this.generateRandomCar();
        await this.writeHandler.writeCar(car);
      } catch (error: any) {
        this.logger.error(`Failed to write car: ${error.message}`);
      }
    }, intervalMs);
  }

  stopSendingCars() {
    this.isShuttingDown = true;

    if (this.generationInterval) {
      clearInterval(this.generationInterval);
      this.generationInterval = null;
      this.logger.log('Car generation stopped');
    }
  }
}
