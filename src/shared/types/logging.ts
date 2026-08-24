import type { IsoTimestamp } from './brand';
import type { LogLevelName } from './config';

export type LogLevel = LogLevelName;

/** Ordering used to filter messages below the configured threshold. */
export const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntry {
  readonly timestamp: IsoTimestamp;
  readonly level: LogLevel;
  /** Dotted component name, e.g. `server.videoIndex`. */
  readonly scope: string;
  readonly message: string;
}

/**
 * Consumes formatted entries. Sinks are the only place log output touches the
 * outside world, which keeps every other module free of console side effects.
 */
export type LogSink = (entry: LogEntry) => void;

export interface Logger {
  readonly debug: (message: string) => void;
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string, cause?: unknown) => void;
  /** Derives a logger that prefixes its scope with the given segment. */
  readonly child: (scope: string) => Logger;
}
