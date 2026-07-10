import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule } from '@nestjs-modules/ioredis';
import { PrismaModule, buildRedisOptions } from '@app/common';

import { MermaidBuilder } from './mermaid/mermaid.builder';
import { ReportRenderer } from './report/report-renderer.service';
import { SynthesizerService } from './synthesis/synthesizer.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildRedisOptions,
    }),
  ],
  providers: [MermaidBuilder, ReportRenderer, SynthesizerService],
})
export class SynthesizerModule {}
