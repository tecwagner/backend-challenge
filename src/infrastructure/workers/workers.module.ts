import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ApplicationModule } from '../../application/application.module.js';
import { PendingReferenceWorker } from './pending-reference.worker.js';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ApplicationModule,
  ],
  providers: [PendingReferenceWorker],
  exports: [PendingReferenceWorker],
})
export class WorkersModule {}
