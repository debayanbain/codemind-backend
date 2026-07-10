import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';
import { JobEventPayload } from '@app/common';

/**
 * Socket.io is only for job status/progress updates (CLAUDE.md Section 2 —
 * no streaming of raw agent "thoughts"). Job lifecycle events originate in
 * orchestrator/agent-worker/synthesizer, which are separate processes, so we
 * relay them here via a Redis pub/sub subscriber rather than emitting
 * directly from those processes.
 */
// `origin: '*'` + credentials is rejected by browsers outright — the client
// connects with `withCredentials` (see lib/socket.ts), so this must echo an
// explicit origin, same as main.ts's enableCors(). Decorator args are static
// (evaluated before Nest's DI/ConfigService exists), so read process.env
// directly here rather than injecting ConfigService.
@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3001',
    credentials: true,
  },
})
export class JobEventsGateway
  implements OnGatewayConnection, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(JobEventsGateway.name);
  private subscriber: Redis;

  @WebSocketServer()
  server: Server;

  constructor(@InjectRedis() private readonly redis: Redis) {
    this.subscriber = redis.duplicate();
  }

  async onModuleInit(): Promise<void> {
    this.subscriber.on(
      'pmessage',
      (_pattern: string, channel: string, message: string) => {
        const jobId = channel.split(':')[1];
        let payload: JobEventPayload;
        try {
          payload = JSON.parse(message) as JobEventPayload;
        } catch {
          this.logger.warn(`Malformed job event on ${channel}: ${message}`);
          return;
        }
        this.server.to(jobId).emit(payload.type, payload);
      },
    );

    await this.subscriber.psubscribe('job:*:events');
    this.logger.log('Subscribed to job:*:events for Socket.io relay');
  }

  onModuleDestroy() {
    this.subscriber.disconnect();
  }

  handleConnection(client: Socket) {
    this.logger.debug(`Client connected: ${client.id}`);
  }

  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @MessageBody() data: { jobId: string },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    await client.join(data.jobId);
  }
}
