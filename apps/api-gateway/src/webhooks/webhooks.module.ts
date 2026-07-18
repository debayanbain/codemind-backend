import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { ClerkWebhookController } from './clerk-webhook.controller';

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [ClerkWebhookController],
})
export class WebhooksModule {}
