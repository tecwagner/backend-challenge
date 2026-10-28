import { Module } from '@nestjs/common';
import { ApplicationModule } from '../application/application.module.js';
import { WalletController } from './controllers/wallet.controller.js';

@Module({
  imports: [ApplicationModule],
  controllers: [WalletController],
  exports: [WalletController],
})
export class HttpApiModule {}
