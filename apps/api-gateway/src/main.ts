import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { createWinstonLogger } from '@app/common';
import { ApiGatewayModule } from './api-gateway.module';

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule, {
    logger: createWinstonLogger('api-gateway'),
    // Keep the raw request body around — the Clerk webhook's Svix signature is
    // over the exact bytes, so it can't be verified from the parsed JSON.
    rawBody: true,
  });
  const config = app.get(ConfigService);

  app.use(cookieParser());
  app.enableCors({
    origin: config.get<string>('FRONTEND_URL', 'http://localhost:3001'),
    credentials: true,
  });

  const port = config.get<number>('API_GATEWAY_PORT', 3000);
  await app.listen(port);

  new Logger('Bootstrap').log(`listening on :${port}`);
}
bootstrap().catch((err) => {
  new Logger('Bootstrap').error('failed to start', err?.stack);
  process.exit(1);
});
