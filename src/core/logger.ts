import pino, { type Logger } from 'pino';

export type VanguardLogger = Logger;

export function createLogger(level: string = process.env.VANGUARD_LOG_LEVEL ?? 'info'): VanguardLogger {
  // In sidecar mode the JSON protocol owns stdout — send logs to stderr (fd 2) so a `{"level":...}`
  // pino line can never be misread as a protocol message. Gated on the env var the __sidecar entry
  // sets, so the CLI's stdout logging is byte-identical when it's unset.
  if (process.env.VANGUARD_SIDECAR === '1') {
    return pino({ level }, pino.destination(2));
  }
  return pino({
    level,
    ...(process.stdout.isTTY ? { transport: { target: 'pino-pretty' } } : {}),
  });
}
