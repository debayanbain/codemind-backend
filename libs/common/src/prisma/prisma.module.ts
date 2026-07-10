import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * @Global so every feature module (auth, repos, jobs, health, ...) across
 * all 4 apps can inject PrismaService without re-importing this module —
 * one client, imported once per app's root module.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
