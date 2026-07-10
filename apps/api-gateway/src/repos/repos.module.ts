import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReposController } from './repos.controller';
import { ReposService } from './repos.service';

@Module({
  imports: [AuthModule],
  controllers: [ReposController],
  providers: [ReposService],
})
export class ReposModule {}
