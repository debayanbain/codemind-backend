import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule } from '@nestjs-modules/ioredis';
import { PrismaModule, buildRedisOptions } from '@app/common';

import { ChartSvgBuilder } from './diagrams/chart-svg.builder';
import { D2Renderer } from './diagrams/d2-renderer.service';
import { D2SourceBuilder } from './diagrams/d2-source.builder';
import { DiagramsService } from './diagrams/diagrams.service';
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
  providers: [
    D2SourceBuilder,
    ChartSvgBuilder,
    D2Renderer,
    DiagramsService,
    ReportRenderer,
    SynthesizerService,
  ],
})
export class SynthesizerModule {}
