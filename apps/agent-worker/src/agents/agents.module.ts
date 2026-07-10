import { Module } from '@nestjs/common';
import { ArchitectureAgent } from './architecture.agent';
import { SecurityAgent } from './security.agent';
import { DependencyAgent } from './dependency.agent';
import { QualityAgent } from './quality.agent';
import { DocsAgent } from './docs.agent';

const AGENTS = [
  ArchitectureAgent,
  SecurityAgent,
  DependencyAgent,
  QualityAgent,
  DocsAgent,
];

@Module({
  providers: AGENTS,
  exports: AGENTS,
})
export class AgentsModule {}
