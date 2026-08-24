import { createExclusiveTask } from '../../../shared/state/store';
import type { ClientConfig } from '../../../shared/types/config';
import type { Logger } from '../../../shared/types/logging';
import type { PlayerApi } from '../../../shared/types/protocol';
import { attemptAsync } from '../../../shared/types/result';
import type { DetailedStats } from '../../../shared/types/status';
import { formatElapsedMs, formatTimestamp } from '../../../shared/util/format';
import { roundTo } from '../../../shared/util/numbers';
import { setClass, setText, type PlayerElements } from '../dom/elements';
import type { OverlayAnchor } from './overlayAnchor';

/**
 * What the panel needs from the running player. The legacy overlay reached
 * straight for `window.electronAPI` and for the player's internals, which is
 * why it only ever worked in Electron.
 */
export interface DebugSnapshot {
  readonly playbackQueueSize: number;
  readonly currentVideoName: string;
  readonly speed: number;
  readonly paused: boolean;
  readonly looping: boolean;
  readonly crossfadeEnabled: boolean;
  readonly blurEnabled: boolean;
  /** Transport state, or null for clients that have no connection to report. */
  readonly connection: string | null;
}

export interface DebugPanelDeps {
  readonly elements: PlayerElements;
  readonly config: ClientConfig;
  readonly api: Pick<PlayerApi, 'getDetailedStats'>;
  readonly snapshot: () => DebugSnapshot;
  readonly anchor: OverlayAnchor;
  readonly logger: Logger;
}

export interface DebugPanel {
  /** Toggles the panel and returns whether it is now visible. */
  readonly toggle: () => boolean;
  readonly isVisible: () => boolean;
  readonly cleanup: () => void;
}

const VISIBLE_CLASS = 'visible';
const NO_VIDEO = 'None';
const NOT_APPLICABLE = 'N/A';

const onOff = (enabled: boolean): string => (enabled ? 'on' : 'off');

export const createDebugPanel = (deps: DebugPanelDeps): DebugPanel => {
  const { elements, config, api, snapshot, anchor, logger } = deps;
  const fields = elements.debugFields;

  // A refresh is in flight across an await, so overlapping ticks are skipped
  // rather than allowed to race each other into the same fields.
  const refreshTask = createExclusiveTask();

  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let release: (() => void) | null = null;
  let visible = false;

  const render = (stats: DetailedStats, state: DebugSnapshot): void => {
    const preprocessed = stats.preprocessedQueue;
    setText(
      fields.queue,
      `${state.playbackQueueSize}/${stats.playbackQueueTarget}` +
        ` (preprocessed: ${preprocessed.current}/${preprocessed.target}` +
        `${stats.isPreprocessing ? ', preprocessing' : ''})`,
    );

    const { playback, persisted } = stats.history;
    setText(
      fields.history,
      `Playback: ${playback.current}/${playback.target}, ` +
        `Persisted: ${persisted.current}/${persisted.target}`,
    );

    setText(fields.currentVideo, state.currentVideoName === '' ? NO_VIDEO : state.currentVideoName);

    setText(
      fields.playback,
      `${roundTo(state.speed, 2)}x, ${state.paused ? 'paused' : 'playing'}, ` +
        `${state.looping ? 'loop' : 'no loop'}`,
    );

    setText(
      fields.effects,
      `Crossfade: ${onOff(state.crossfadeEnabled)}, Blur: ${onOff(state.blurEnabled)}`,
    );

    const session = stats.session;
    setText(
      fields.session,
      `Played: ${session.videosPlayed}, Errors: ${session.videosSkippedByError}, ` +
        `Skips: ${session.videosSkippedManually}, Previous: ${session.videosReturnedToPrevious}` +
        ` | Indexed: ${session.totalVideosIndexed}, ` +
        `Updated: ${formatTimestamp(stats.lastIndexUpdate)}, ` +
        `Next: ${formatElapsedMs(stats.timeUntilNextUpdate)}`,
    );

    setText(fields.connection, state.connection === null ? NOT_APPLICABLE : state.connection);
  };

  const refresh = async (): Promise<void> => {
    await refreshTask.runExclusive(async () => {
      const stats = await attemptAsync(() => api.getDetailedStats());
      if (!stats.ok) {
        // Refreshes repeat on a timer, so a failing server would flood any
        // higher level than debug.
        logger.debug(`Debug stats unavailable - ${stats.error.message}`);
        return;
      }
      // The panel may have been closed while the request was in flight.
      if (!visible) return;
      render(stats.value, snapshot());
    });
  };

  const stopRefreshing = (): void => {
    if (refreshTimer === null) return;
    clearInterval(refreshTimer);
    refreshTimer = null;
  };

  const hide = (panel: HTMLElement): boolean => {
    visible = false;
    stopRefreshing();
    setClass(panel, VISIBLE_CLASS, false);
    if (release !== null) {
      release();
      release = null;
    }
    logger.debug('Debug panel hidden');
    return false;
  };

  const show = (panel: HTMLElement): boolean => {
    visible = true;
    if (release === null) release = anchor.acquire();
    setClass(panel, VISIBLE_CLASS, true);
    void refresh();
    if (refreshTimer === null) {
      refreshTimer = setInterval(() => {
        void refresh();
      }, config.timeouts.debugUpdateInterval);
    }
    logger.debug('Debug panel shown');
    return true;
  };

  return {
    toggle: () => {
      const panel = elements.debugOverlay;
      // The TV build ships no debug markup at all.
      if (panel === null) return false;
      return visible ? hide(panel) : show(panel);
    },
    isVisible: () => visible,
    cleanup: () => {
      const panel = elements.debugOverlay;
      if (panel === null) return;
      hide(panel);
    },
  };
};
