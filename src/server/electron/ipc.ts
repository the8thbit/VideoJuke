import { ipcMain } from 'electron';

import type { Logger } from '../../shared/types/logging';
import { IPC_CHANNELS, type IpcChannel, type ServerEvent } from '../../shared/types/protocol';
import type { PreprocessedVideo } from '../../shared/types/video';
import type { PlayerService } from '../api/playerService';
import type { Session } from '../domain/session';
import { decodeLeaderPublication } from '../domain/leaderPublication';
import { decodePreprocessedVideo, decodePreprocessedVideoList } from '../domain/videoRecords';
import type { ServerLogging } from '../infra/logger';
import type { PlayerWindow } from './window';

export interface PlayerIpcOptions {
  readonly service: PlayerService;
  readonly session: Session;
  readonly window: PlayerWindow;
  readonly logging: ServerLogging;
  readonly logger: Logger;
}

/** Every handler is invoked with the single payload the renderer passed. */
type ChannelHandler = (payload: unknown) => Promise<unknown>;

type Registration = readonly [IpcChannel, ChannelHandler];

/** Whatever the renderer sends for a message, reduced to something printable. */
const readErrorMessage = (payload: unknown): string =>
  typeof payload === 'string' && payload.trim() !== '' ? payload : 'unspecified renderer error';

/**
 * Wires the renderer to the player service.
 *
 * Nothing here makes decisions: each channel forwards to the matching service
 * method, and the only work done on the way is decoding. Renderer payloads
 * arrive as `unknown` and are turned into domain records by the same decoders
 * the cache files go through, because a compromised or simply out-of-date
 * renderer must not be able to hand the server a half-built video.
 */
export const registerPlayerIpc = (options: PlayerIpcOptions): (() => void) => {
  const { service, session, window, logging, logger } = options;
  const videoPaths = session.videoPaths;

  /** Null when the payload is not a usable video record. */
  const readVideo = (payload: unknown, channel: IpcChannel): PreprocessedVideo | null => {
    const video = decodePreprocessedVideo(payload, videoPaths);
    if (video === null) {
      logger.warn(`ignoring a ${channel} payload that is not a video record`);
    }
    return video;
  };

  /** For the channels where "no video" is a legitimate thing to report. */
  const readOptionalVideo = (payload: unknown): PreprocessedVideo | null =>
    payload === null || payload === undefined ? null : decodePreprocessedVideo(payload, videoPaths);

  const ensurePlayable = async (payload: unknown): Promise<unknown> => {
    const video = readVideo(payload, IPC_CHANNELS.ensurePlayable);
    if (video === null) return null;
    return service.ensurePlayable(video);
  };

  /**
   * The one channel whose payload is not the video itself.
   *
   * `LeaderPublication` wraps the record in `{ video, positionSeconds, paused,
   * rate }` and the preload forwards it unchanged, but this handler decoded the
   * wrapper: no `originalPath` on it, so every publication answered null and an
   * Electron leader warned once a second while never leading anything. Shared
   * with the HTTP route now, which is where the correct reader already lived.
   */
  const publishLeaderState = async (payload: unknown): Promise<void> => {
    const published = decodeLeaderPublication(payload, videoPaths);
    if (published === null) {
      logger.warn(`ignoring a ${IPC_CHANNELS.publishLeaderState} payload that is not a video record`);
      return;
    }
    await service.publishLeaderState(published);
  };

  const locatePlayable = async (payload: unknown): Promise<unknown> => {
    const video = readVideo(payload, IPC_CHANNELS.locatePlayable);
    if (video === null) return null;
    return service.locatePlayable(video);
  };

  const toggleArchiveFlag = async (payload: unknown): Promise<unknown> => {
    const video = readVideo(payload, IPC_CHANNELS.toggleArchiveFlag);
    if (video === null) return false;
    return service.toggleArchiveFlag(video);
  };

  const recordVideoEnded = async (payload: unknown): Promise<void> => {
    const video = readVideo(payload, IPC_CHANNELS.recordVideoEnded);
    if (video === null) return;
    await service.recordVideoEnded(video);
  };

  const registrations: readonly Registration[] = [
    [IPC_CHANNELS.getConfig, () => service.getConfig()],
    [IPC_CHANNELS.getStatus, () => service.getStatus()],
    [IPC_CHANNELS.getDetailedStats, () => service.getDetailedStats()],
    [IPC_CHANNELS.takeNextVideo, () => service.takeNextVideo()],
    [IPC_CHANNELS.takePreviousVideo, () => service.takePreviousVideo()],
    [IPC_CHANNELS.ensurePlayable, ensurePlayable],
    [IPC_CHANNELS.recordVideoEnded, recordVideoEnded],
    [
      IPC_CHANNELS.recordVideoError,
      (payload) => service.recordVideoError(readErrorMessage(payload)),
    ],
    [
      IPC_CHANNELS.recordManualSkip,
      (payload) => service.recordManualSkip(readOptionalVideo(payload)),
    ],
    [
      IPC_CHANNELS.recordReturnToPrevious,
      (payload) => service.recordReturnToPrevious(readOptionalVideo(payload)),
    ],
    [
      IPC_CHANNELS.syncPlaybackQueue,
      (payload) => service.syncPlaybackQueue(decodePreprocessedVideoList(payload, videoPaths)),
    ],
    [IPC_CHANNELS.toggleArchiveFlag, toggleArchiveFlag],
    [IPC_CHANNELS.publishLeaderState, publishLeaderState],
    [IPC_CHANNELS.getLeaderState, () => service.getLeaderState()],
    [IPC_CHANNELS.locatePlayable, locatePlayable],
    [IPC_CHANNELS.requestShutdown, () => service.requestShutdown()],
  ];

  for (const [channel, handler] of registrations) {
    ipcMain.handle(channel, (_event, payload: unknown) => handler(payload));
  }

  const forward = (event: ServerEvent): void => {
    window.send(IPC_CHANNELS.serverEvent, event);
  };

  const unsubscribeInitialization = session.onInitializationChange((state) => {
    forward({ type: 'initialization', state });
  });

  // Only ever an early wake-up: a follower polls regardless, because the webOS
  // client has no socket at all and the poll is also its clock probe.
  const unsubscribeLeader = session.onLeaderStateChange((state) => {
    forward({ type: 'leader-state', state });
  });

  // The loading screen renders the server's own log, so entries fan out to the
  // renderer as they are produced rather than being polled for.
  const unsubscribeLog = logging.subscribe((entry) => {
    forward({ type: 'log', entry });
  });

  logger.info(`registered ${registrations.length} IPC handlers`);

  return () => {
    unsubscribeInitialization();
    unsubscribeLeader();
    unsubscribeLog();
    for (const [channel] of registrations) {
      ipcMain.removeHandler(channel);
    }
    logger.debug('removed the IPC handlers');
  };
};
