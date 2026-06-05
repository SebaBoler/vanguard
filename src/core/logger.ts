import pino, { type Logger } from 'pino';

export type VanguardLogger = Logger;

export function createLogger(level: string = process.env.VANGUARD_LOG_LEVEL ?? 'info'): VanguardLogger {
  return pino({
    level,
    ...(process.stdout.isTTY ? { transport: { target: 'pino-pretty' } } : {}),
  });
}
