import { Module } from '@nestjs/common';
import { CarSeederModule } from './modules/car-seeder/car-seeder.module';
import { CommonModule } from './modules/common/common.module';

@Module({
  imports: [CommonModule, CarSeederModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
