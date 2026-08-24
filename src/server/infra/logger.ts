import type { IsoTimestamp } from '../../shared/types/brand';
import type { LogEntry, LogLevel, Logger, LogSink } from '../../shared/types/logging';
import { createConsoleSink, createLogger } from '../../shared/logging/logger';
import { toIsoTimestamp } from '../../shared/time/clock';

/**
 * The server logger both prints and republishes: clients render the same
 * entries in their loading screen, so entries fan out to a live set of
 * listeners as well as to the console.
 */
export interface ServerLogging {
  readonly logger: Logger;
  readonly subscribe: (listener: (entry: LogEntry) => void) => () => void;
}

export interface ServerLoggingOptions {
  readonly scope: string;
  readonly minLevel: LogLevel;
  readonly now?: () => IsoTimestamp;
}

export const createServerLogging = ({
  scope,
  minLevel,
  now = () => toIsoTimestamp(Date.now()),
}: ServerLoggingOptions): ServerLogging => {
  const listeners = new Set<(entry: LogEntry) => void>();
  const consoleSink = createConsoleSink(console);

  const sink: LogSink = (entry) => {
    consoleSink(entry);
    for (const listener of Array.from(listeners)) {
      listener(entry);
    }
  };

  return {
    logger: createLogger({ scope, minLevel, sink, now }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
