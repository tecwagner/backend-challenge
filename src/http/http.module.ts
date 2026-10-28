import { Module } from '@nestjs/common';
import { ApplicationModule } from '../application/application.module.js';
import { WalletController } from './controllers/wallet.controller.js';
import { WageringController } from './controllers/wagering.controller.js';

@Module({
  imports: [ApplicationModule],
  controllers: [WalletController, WageringController],
  exports: [WalletController, WageringController],
})
export class HttpApiModule {}
