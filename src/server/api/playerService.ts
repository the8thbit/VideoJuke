import { toClientConfig } from '../../shared/types/config';
import type { PlayerApi } from '../../shared/types/protocol';
import type { PlayableVideo, PreprocessedVideo, VideoLocation } from '../../shared/types/video';
import type { Session } from '../domain/session';

/**
 * Everything a transport must answer, minus the event stream it owns itself:
 * Electron pushes events down a `WebContents`, the web server broadcasts them
 * over a WebSocket, and neither shape belongs in a shared handler.
 */
export type PlayerService = Omit<PlayerApi, 'subscribe'>;

export interface PlayerServiceOptions {
  /**
   * Where the client should load a transcode from. Electron reads the temp
   * file directly; the web server hands out a URL it will stream.
   */
  readonly locate: (video: PreprocessedVideo) => VideoLocation;
  readonly onShutdownRequest: () => void | Promise<void>;
  /** The server's own clock, which is the only one every screen can agree on. */
  readonly now: () => number;
}

/**
 * The one implementation of the client-facing protocol.
 *
 * The legacy build wrote these handlers twice, once as IPC channels and once
 * as REST routes, and they had already drifted: only the web copy validated
 * that a transcode still existed, and only the Electron copy saved state on
 * shutdown. A transport now supplies just the two things that genuinely differ.
 */
export const createPlayerService = (
  session: Session,
  options: PlayerServiceOptions,
): PlayerService => {
  const toPlayable = (video: PreprocessedVideo | null): PlayableVideo | null =>
    video === null ? null : { ...video, location: options.locate(video) };

  return {
    getConfig: async () => toClientConfig(session.config()),
    getStatus: async () => session.status(),
    getDetailedStats: async () => session.detailedStats(),

    takeNextVideo: async () => toPlayable(session.takeNextVideo()),
    takePreviousVideo: async () => toPlayable(session.takePreviousVideo()),
    ensurePlayable: async (video) => toPlayable(await session.ensurePlayable(video)),

    recordVideoEnded: async (video) => {
      session.recordVideoEnded(video);
    },
    recordVideoError: async (message) => {
      session.recordVideoError(message);
    },
    recordManualSkip: async (video) => {
      session.recordManualSkip(video);
    },
    recordReturnToPrevious: async (video) => {
      session.recordReturnToPrevious(video);
    },

    syncPlaybackQueue: async (videos) => {
      session.syncPlaybackQueue(videos);
    },

    toggleArchiveFlag: (video) => session.toggleArchiveFlag(video),

    publishLeaderState: async (state) => {
      session.publishLeaderState(state);
    },
    getLeaderState: async () => ({
      state: session.leaderState(),
      // Answered from the same call the follower is already making, so the
      // round trip that carries the state also measures the clock offset.
      serverNowMs: options.now(),
    }),
    locatePlayable: async (video) => toPlayable(await session.locatePlayable(video)),

    requestShutdown: async () => {
      await options.onShutdownRequest();
    },
  };
};
