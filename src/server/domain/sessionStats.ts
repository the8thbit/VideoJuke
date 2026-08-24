import { createStore } from '../../shared/state/store';
import type { IsoTimestamp } from '../../shared/types/brand';
import { EMPTY_SESSION_STATS, type SessionStats } from '../../shared/types/status';

/** The fields of {@link SessionStats} that only ever go up. */
export type StatsCounter =
  | 'preprocessedVideos'
  | 'preprocessingErrors'
  | 'videosPlayed'
  | 'videosSkippedByError'
  | 'videosSkippedManually'
  | 'videosReturnedToPrevious';

export interface SessionStatsStore {
  readonly get: () => SessionStats;
  readonly increment: (counter: StatsCounter, by?: number) => void;
  readonly setIndexed: (total: number, at: IsoTimestamp) => void;
}

/**
 * The counters behind the debug overlay.
 *
 * The legacy servers passed one mutable `stats` object into every component and
 * let each of them write whatever fields it liked, so the queue incremented
 * counters the server also incremented and nobody owned the total. Here the
 * numbers live in a store and the only ways in are these three methods.
 */
export const createSessionStatsStore = (): SessionStatsStore => {
  const stats = createStore<SessionStats>(EMPTY_SESSION_STATS);

  return {
    get: stats.get,

    increment: (counter, by = 1) => {
      stats.update((previous) => {
        // A partial record rather than a switch over six identical cases: the
        // counter names are exactly the numeric fields of SessionStats, so the
        // spread stays type-safe without enumerating them twice.
        const change: Partial<Record<StatsCounter, number>> = {
          [counter]: previous[counter] + by,
        };
        return { ...previous, ...change };
      });
    },

    setIndexed: (total, at) => {
      stats.update((previous) => ({
        ...previous,
        totalVideosIndexed: total,
        lastIndexUpdate: at,
      }));
    },
  };
};
