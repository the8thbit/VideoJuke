import type { IsoTimestamp } from '../types/brand';
import {
  LOG_LEVEL_RANK,
  type LogEntry,
  type LogLevel,
  type LogSink,
  type Logger,
} from '../types/logging';

/**
 * The slice of `console` this module needs. It is declared here rather than
 * taken from a global because `shared/` is compiled against both the Node and
 * the DOM lib, and neither `Console` type is available in both.
 */
export interface ConsoleLike {
  debug(...args: readonly unknown[]): void;
  info(...args: readonly unknown[]): void;
  warn(...args: readonly unknown[]): void;
  error(...args: readonly unknown[]): void;
}

interface LoggerOptions {
  /** Dotted component name; {@link Logger.child} appends a segment to it. */
  readonly scope: string;
  /** Entries ranked below this level never reach the sink. */
  readonly minLevel: LogLevel;
  readonly sink: LogSink;
  /** Injected clock, so tests get stable timestamps. */
  readonly now: () => IsoTimestamp;
}

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const appendCause = (message: string, cause: unknown): string =>
  cause === undefined || cause === null ? message : `${message} - ${describeCause(cause)}`;

/**
 * Builds a logger that stamps entries with a scope and a timestamp and hands
 * them to one sink. Deciding where output goes is the sink's job, which is what
 * keeps every other module free of `console` and lets the same logger serve
 * Electron, a browser and a test run.
 */
export const createLogger = (options: LoggerOptions): Logger => {
  const { scope, minLevel, sink, now } = options;
  const threshold = LOG_LEVEL_RANK[minLevel];

  const emit = (level: LogLevel, message: string): void => {
    // Filter before building the entry so a dropped debug line costs no clock read.
    if (LOG_LEVEL_RANK[level] < threshold) return;
    sink({ timestamp: now(), level, scope, message });
  };

  return {
    debug: (message) => emit('debug', message),
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message, cause) => emit('error', appendCause(message, cause)),
    child: (childScope) => createLogger({ ...options, scope: `${scope}.${childScope}` }),
  };
};

/** Single-line rendering: `[2026-08-21T14:03:59.123Z] [INFO] [server.index] Ready`. */
export const formatLogEntry = (entry: LogEntry): string =>
  `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}`;

/** Writes entries to a console, choosing the method that matches the level. */
export const createConsoleSink = (target: ConsoleLike): LogSink => (entry) => {
  const line = formatLogEntry(entry);
  switch (entry.level) {
    case 'debug':
      target.debug(line);
      return;
    case 'info':
      target.info(line);
      return;
    case 'warn':
      target.warn(line);
      return;
    case 'error':
      target.error(line);
      return;
  }
};
