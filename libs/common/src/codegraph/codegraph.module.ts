import { Module } from '@nestjs/common';
import { CodeGraphService } from './codegraph.service';

@Module({
  providers: [CodeGraphService],
  exports: [CodeGraphService],
})
export class CodeGraphModule {}
