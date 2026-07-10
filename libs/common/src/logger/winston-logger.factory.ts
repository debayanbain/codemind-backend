import * as path from 'path';
import * as winston from 'winston';
import 'winston-daily-rotate-file';
import { WinstonModule, utilities as nestWinstonUtilities } from 'nest-winston';

// One factory, called once per app's main.ts with that app's own name
// (api-gateway | orchestrator | agent-worker | synthesizer). Every service
// still logs through Nest's `Logger` class as before — `app.useLogger()`
// just swaps the transport underneath — so this is the single place that
// decides how/where logs go, not a rewrite of every call site.
//
// Each app gets its OWN log file, one file per calendar day (day by day),
// which is the direct fix for "I want to see api-gateway's logs without
// agent-worker's mixed in" — `tail -f logs/api-gateway-2026-07-05.log` vs
// `tail -f logs/agent-worker-2026-07-05.log`, instead of grepping one
// interleaved stream. `maxFiles: '15d'` makes winston delete any rotated
// file older than 15 days on its own — no cron/logrotate needed.
export function createWinstonLogger(appName: string) {
  const isProd = process.env.NODE_ENV === 'production';
  const logDir = process.env.LOG_DIR ?? path.join(process.cwd(), 'logs');
  const level = process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug');
  const retention = process.env.LOG_RETENTION_DAYS ?? '15d';

  const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  );

  return WinstonModule.createLogger({
    level,
    defaultMeta: { app: appName },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          isProd
            ? winston.format.json()
            : nestWinstonUtilities.format.nestLike(appName, {
                colors: true,
                prettyPrint: true,
              }),
        ),
      }),
      new winston.transports.DailyRotateFile({
        dirname: logDir,
        filename: `${appName}-%DATE%.log`,
        datePattern: 'YYYY-MM-DD',
        format: fileFormat,
        maxFiles: retention,
      }),
      new winston.transports.DailyRotateFile({
        dirname: logDir,
        filename: `${appName}-%DATE%.error.log`,
        datePattern: 'YYYY-MM-DD',
        level: 'error',
        format: fileFormat,
        maxFiles: retention,
      }),
    ],
  });
}
