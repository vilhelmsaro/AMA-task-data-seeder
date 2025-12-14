import { Module } from '@nestjs/common';
import { CarSeederService } from './car-seeder.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [],
  providers: [CarSeederService],
})
export class CarSeederModule {}
