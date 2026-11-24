import type { ClientConfig } from './config';
import type { LogEntry } from './logging';
import type { ConfigPatch, ConfigSaveResult, EditableConfig, LogRecord } from './settings';
import type { DetailedStats, PipelineState, ServiceStatus } from './status';
import type { PlayableVideo, PreprocessedVideo } from './video';

/** Cancels a subscription created with {@link PlayerApi.subscribe}. */
export type Unsubscribe = () => void;

/**
 * What a leading screen says it is doing, as the server retells it.
 *
 * The video is a `PreprocessedVideo` and deliberately not a `PlayableVideo`:
 * `location` carries a signed, expiring stream URL, so putting one on the wire
 * would hand every follower a credential minted for somebody else that stops
 * working part-way through the video. Each follower asks for its own.
 *
 * `anchorMs` is the *server's* clock, not the leader's. Two devices in a house
 * can disagree about the time by hours - a TV that has never reached a time
 * server is routinely wrong - so no follower ever compares its clock to a
 * leader's. Everything is measured against the one clock they can both probe.
 */
export interface LeaderState {
  /** Increases with every publication, so a late one can be discarded. */
  readonly sequence: number;
  readonly video: PreprocessedVideo;
  readonly positionSeconds: number;
  readonly paused: boolean;
  /** The leader's own playback rate, which followers match before correcting. */
  readonly rate: number;
  /** Server time when this was accepted; the origin for every extrapolation. */
  readonly anchorMs: number;
}

/** What a leader reports. The server supplies the sequence and the anchor. */
export interface LeaderPublication {
  readonly video: PreprocessedVideo;
  readonly positionSeconds: number;
  readonly paused: boolean;
  readonly rate: number;
}

/**
 * A leader state plus the server's clock at the moment it answered.
 *
 * The pair is what makes a follower's offset estimate possible from an ordinary
 * poll: with the request and response times either side of `serverNowMs`, the
 * follower knows how far its own clock is from the server's without either of
 * them having to be right about the actual time.
 */
export interface LeaderSnapshot {
  readonly state: LeaderState | null;
  readonly serverNowMs: number;
}

/** Pushed from the server to every connected client. */
export type ServerEvent =
  | { readonly type: 'pipeline'; readonly state: PipelineState }
  | { readonly type: 'log'; readonly entry: LogEntry }
  /**
   * Only ever an early wake-up. Followers poll regardless, because the webOS
   * client runs with no WebSocket at all, and the poll is also how they measure
   * their clock offset - so this saves a second of latency and nothing more.
   */
  | { readonly type: 'leader-state'; readonly state: LeaderState };

/**
 * The complete surface a client needs from a server, independent of transport.
 * Electron implements it over IPC and browsers over HTTP plus a WebSocket, so
 * the player itself never learns which environment it is running in.
 */
export interface PlayerApi {
  readonly getConfig: () => Promise<ClientConfig>;
  readonly getStatus: () => Promise<ServiceStatus>;
  readonly getDetailedStats: () => Promise<DetailedStats>;

  /**
   * The start screen's three steps. Index and queue are asked of the server,
   * which runs them in the background and reports through `getStatus` and the
   * `pipeline` event; play is the client's own business.
   */
  readonly startIndex: () => Promise<void>;
  readonly startQueue: () => Promise<void>;
  /** Forgets the index and the queue built from it, on disk as well. */
  readonly clearIndex: () => Promise<void>;
  /** Forgets the prepared queue and deletes its transcodes. */
  readonly clearQueue: () => Promise<void>;
  /** Clears the queue and prepares a fresh one straight away. */
  readonly requeue: () => Promise<void>;
  /**
   * This session's auto-queue and auto-play. The `startup` settings are only
   * where each new session starts from, so changing these leaves them alone.
   */
  readonly setAutoQueue: (enabled: boolean) => Promise<void>;
  readonly setAutoPlay: (enabled: boolean) => Promise<void>;

  /** The settings as the options panel shows them. */
  readonly getEditableConfig: () => Promise<EditableConfig>;
  /** Saves the changed fields; a refused save writes nothing at all. */
  readonly saveConfig: (patch: ConfigPatch) => Promise<ConfigSaveResult>;
  /** Recent warnings and errors, for the log under the options panel. */
  readonly getRecentLog: () => Promise<readonly LogRecord[]>;

  /** Takes the next transcoded video out of the server-side queue. */
  readonly takeNextVideo: () => Promise<PlayableVideo | null>;
  /** Takes the most recently played video back out of history. */
  readonly takePreviousVideo: () => Promise<PlayableVideo | null>;
  /** Re-transcodes a video whose temp file has since been cleaned up. */
  readonly ensurePlayable: (video: PreprocessedVideo) => Promise<PlayableVideo | null>;

  readonly recordVideoEnded: (video: PreprocessedVideo) => Promise<void>;
  readonly recordVideoError: (message: string) => Promise<void>;
  readonly recordManualSkip: (video: PreprocessedVideo | null) => Promise<void>;
  readonly recordReturnToPrevious: (video: PreprocessedVideo | null) => Promise<void>;

  /**
   * Mirrors the client-side queue to the server so a restart can resume it.
   * Replaces the old trick of evaluating JavaScript inside the renderer.
   */
  readonly syncPlaybackQueue: (videos: readonly PreprocessedVideo[]) => Promise<void>;

  /**
   * Flags the video for archiving, or clears the flag if it already had one.
   * Resolves to the state it ended up in, which is what the on-screen indicator
   * reports; the client never has to hold its own copy of the list.
   */
  readonly toggleArchiveFlag: (video: PreprocessedVideo) => Promise<boolean>;

  /** Reports what this screen is playing, for other screens to mirror. */
  readonly publishLeaderState: (state: LeaderPublication) => Promise<void>;
  /** Asks what the leading screen is playing, and what the server's clock says. */
  readonly getLeaderState: () => Promise<LeaderSnapshot>;
  /**
   * Mints a fresh playable location for a video a follower was told about.
   * Unlike `ensurePlayable` this never transcodes: it answers null instead, so a
   * follower can never make the server do real work by asking repeatedly.
   */
  readonly locatePlayable: (video: PreprocessedVideo) => Promise<PlayableVideo | null>;

  readonly requestShutdown: () => Promise<void>;
  readonly subscribe: (listener: (event: ServerEvent) => void) => Unsubscribe;
}

/** Channel names shared by the Electron main and renderer processes. */
export const IPC_CHANNELS = {
  getConfig: 'player:get-config',
  getStatus: 'player:get-status',
  getDetailedStats: 'player:get-detailed-stats',
  startIndex: 'player:start-index',
  startQueue: 'player:start-queue',
  clearIndex: 'player:clear-index',
  clearQueue: 'player:clear-queue',
  requeue: 'player:requeue',
  setAutoQueue: 'player:set-auto-queue',
  setAutoPlay: 'player:set-auto-play',
  getEditableConfig: 'player:get-editable-config',
  saveConfig: 'player:save-config',
  getRecentLog: 'player:get-recent-log',
  takeNextVideo: 'player:take-next-video',
  takePreviousVideo: 'player:take-previous-video',
  ensurePlayable: 'player:ensure-playable',
  recordVideoEnded: 'player:record-video-ended',
  recordVideoError: 'player:record-video-error',
  recordManualSkip: 'player:record-manual-skip',
  recordReturnToPrevious: 'player:record-return-to-previous',
  syncPlaybackQueue: 'player:sync-playback-queue',
  toggleArchiveFlag: 'player:toggle-archive-flag',
  publishLeaderState: 'player:publish-leader-state',
  getLeaderState: 'player:get-leader-state',
  locatePlayable: 'player:locate-playable',
  requestShutdown: 'player:request-shutdown',
  serverEvent: 'player:server-event',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** HTTP routes exposed by the web server, kept next to the IPC channel names. */
export const HTTP_ROUTES = {
  config: '/api/config',
  status: '/api/status',
  detailedStats: '/api/detailed-stats',
  startIndex: '/api/pipeline/index',
  startQueue: '/api/pipeline/queue',
  clearIndex: '/api/pipeline/index/clear',
  clearQueue: '/api/pipeline/queue/clear',
  requeue: '/api/pipeline/requeue',
  autoQueue: '/api/pipeline/auto-queue',
  autoPlay: '/api/pipeline/auto-play',
  /** GET reads the editable settings, POST saves a patch. */
  settings: '/api/settings',
  recentLog: '/api/log',
  nextVideo: '/api/next-video',
  previousVideo: '/api/previous-video',
  ensurePlayable: '/api/ensure-playable',
  videoEnded: '/api/video-ended',
  videoError: '/api/video-error',
  manualSkip: '/api/manual-skip',
  returnToPrevious: '/api/return-to-previous',
  syncPlaybackQueue: '/api/playback-queue',
  toggleArchiveFlag: '/api/archive-flag',
  publishLeaderState: '/api/leader-state',
  getLeaderState: '/api/leader-state',
  locatePlayable: '/api/locate-playable',
  health: '/health',
  videoStream: '/videos',
} as const;

/** Query parameter naming the temp file to stream from {@link HTTP_ROUTES.videoStream}. */
export const VIDEO_STREAM_FILENAME_PARAM = 'filename';

/**
 * The two parameters that authorise a stream request.
 *
 * A `<video>` element cannot send an `Authorization` header, so the stream route
 * cannot be protected the way the API is. Instead the server signs each URL it
 * hands out: `expires` is when it stops working and `sig` is a keyed digest over
 * the pair. The shared secret itself is never in the URL, so nothing that sees
 * one - a proxy, an access log, a browser history - learns anything reusable
 * beyond that one file for that one window.
 */
export const VIDEO_STREAM_EXPIRES_PARAM = 'expires';
export const VIDEO_STREAM_SIGNATURE_PARAM = 'sig';

/** Header carrying the shared secret on every API request. */
export const AUTH_HEADER = 'authorization';
export const AUTH_SCHEME = 'Bearer';

/** Query parameter the browser client accepts a token on, once, to enrol. */
export const AUTH_TOKEN_PARAM = 'token';

/**
 * Named first in the WebSocket subprotocol list, with the token second.
 *
 * The constructor's subprotocol argument is the only header a browser lets a
 * page influence on a WebSocket upgrade, which is why the credential travels
 * there rather than in the URL.
 */
export const WEBSOCKET_SUBPROTOCOL = 'videojuke';
