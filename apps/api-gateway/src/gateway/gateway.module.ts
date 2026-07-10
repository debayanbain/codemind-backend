import { Module } from '@nestjs/common';
import { JobEventsGateway } from './job-events.gateway';

@Module({
  providers: [JobEventsGateway],
})
export class EventsGatewayModule {}
