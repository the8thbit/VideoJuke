import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { ClientConfig } from '../../shared/types/config';
import {
  IPC_CHANNELS,
  type LeaderSnapshot,
  type PlayerApi,
  type ServerEvent,
  type Unsubscribe,
} from '../../shared/types/protocol';
import type { DetailedStats, ServiceStatus } from '../../shared/types/status';
import type { PlayableVideo } from '../../shared/types/video';

declare global {
  interface Window {
    readonly videojuke?: PlayerApi;
  }
}

/**
 * `ipcRenderer.invoke` is typed as returning `any`, so every call names the
 * type it expects here and the renderer sees a fully typed `PlayerApi`.
 */
const invoke = <TResult>(channel: string, payload?: unknown): Promise<TResult> =>
  ipcRenderer.invoke(channel, payload) as Promise<TResult>;

const subscribe = (listener: (event: ServerEvent) => void): Unsubscribe => {
  const forward = (_event: IpcRendererEvent, payload: unknown): void => {
    // The payload is built by our own main process from typed values, so it is
    // handed on as it arrives; the untrusted direction is renderer to main.
    listener(payload as ServerEvent);
  };

  ipcRenderer.on(IPC_CHANNELS.serverEvent, forward);

  // Removes this listener and no other. The legacy preload called
  // removeAllListeners whenever anything registered, so a second subscriber
  // silently evicted the first and the loading screen went quiet.
  return () => {
    ipcRenderer.removeListener(IPC_CHANNELS.serverEvent, forward);
  };
};

/**
 * The Electron half of the transport. It is the whole of what the renderer can
 * reach: context isolation is on and the bridge exposes this object only, so
 * nothing else in Node is visible from the page.
 */
const videojuke: PlayerApi = {
  getConfig: () => invoke<ClientConfig>(IPC_CHANNELS.getConfig),
  getStatus: () => invoke<ServiceStatus>(IPC_CHANNELS.getStatus),
  getDetailedStats: () => invoke<DetailedStats>(IPC_CHANNELS.getDetailedStats),

  takeNextVideo: () => invoke<PlayableVideo | null>(IPC_CHANNELS.takeNextVideo),
  takePreviousVideo: () => invoke<PlayableVideo | null>(IPC_CHANNELS.takePreviousVideo),
  ensurePlayable: (video) => invoke<PlayableVideo | null>(IPC_CHANNELS.ensurePlayable, video),

  recordVideoEnded: (video) => invoke<void>(IPC_CHANNELS.recordVideoEnded, video),
  recordVideoError: (message) => invoke<void>(IPC_CHANNELS.recordVideoError, message),
  recordManualSkip: (video) => invoke<void>(IPC_CHANNELS.recordManualSkip, video),
  recordReturnToPrevious: (video) => invoke<void>(IPC_CHANNELS.recordReturnToPrevious, video),

  syncPlaybackQueue: (videos) => invoke<void>(IPC_CHANNELS.syncPlaybackQueue, videos),

  toggleArchiveFlag: (video) => invoke<boolean>(IPC_CHANNELS.toggleArchiveFlag, video),

  publishLeaderState: (state) => invoke<void>(IPC_CHANNELS.publishLeaderState, state),
  getLeaderState: () => invoke<LeaderSnapshot>(IPC_CHANNELS.getLeaderState),
  locatePlayable: (video) => invoke<PlayableVideo | null>(IPC_CHANNELS.locatePlayable, video),

  requestShutdown: () => invoke<void>(IPC_CHANNELS.requestShutdown),
  subscribe,
};

contextBridge.exposeInMainWorld('videojuke', videojuke);
