import type { IsoTimestamp } from '../../shared/types/brand';
import type { LogEntry, LogLevel, Logger, LogSink } from '../../shared/types/logging';
import { LOG_LEVEL_RANK } from '../../shared/types/logging';
import type { LogRecord } from '../../shared/types/settings';
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
  /**
   * The most recent warnings and errors, oldest first, for the log at the
   * bottom of the options panel. Only those levels, so a busy index does not
   * push the one error that matters off the end with progress lines.
   */
  readonly recentProblems: () => readonly LogRecord[];
}

export interface ServerLoggingOptions {
  readonly scope: string;
  readonly minLevel: LogLevel;
  readonly now?: () => IsoTimestamp;
  /**
   * Entries logged before this logging existed - the bootstrap's own complaints
   * about config.json, say - so they still reach the panel.
   */
  readonly seed?: readonly LogEntry[];
}

/** How many problems the panel can scroll back through. */
const RECENT_PROBLEM_LIMIT = 200;

const isProblem = (entry: LogEntry): boolean => LOG_LEVEL_RANK[entry.level] >= LOG_LEVEL_RANK.warn;

export const createServerLogging = ({
  scope,
  minLevel,
  now = () => toIsoTimestamp(Date.now()),
  seed = [],
}: ServerLoggingOptions): ServerLogging => {
  const listeners = new Set<(entry: LogEntry) => void>();
  const consoleSink = createConsoleSink(console);
  // A plain array rather than a store: it is appended to on every warning, and
  // copying a 200-entry list each time would be the only cost of logging.
  const recent: LogRecord[] = [];
  let sequence = 0;

  const remember = (entry: LogEntry): void => {
    if (!isProblem(entry)) return;
    sequence += 1;
    recent.push({ ...entry, sequence });
    if (recent.length > RECENT_PROBLEM_LIMIT) recent.splice(0, recent.length - RECENT_PROBLEM_LIMIT);
  };

  for (const entry of seed) {
    remember(entry);
  }

  const sink: LogSink = (entry) => {
    consoleSink(entry);
    remember(entry);
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
    recentProblems: () => recent.slice(),
  };
};
