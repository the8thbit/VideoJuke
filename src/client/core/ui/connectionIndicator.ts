import { setText } from '../dom/elements';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface ConnectionIndicator {
  readonly set: (state: ConnectionState) => void;
  readonly hide: () => void;
}

const BASE_CLASS = 'connection-status';
const HIDDEN_CLASS = 'hidden';

const LABELS: Readonly<Record<ConnectionState, string>> = {
  connecting: 'Connecting...',
  connected: 'Connected',
  disconnected: 'Disconnected',
  failed: 'Connection failed',
};

/**
 * The little badge the browser client shows while it is talking to the server.
 *
 * A healthy connection is not news, so reaching `connected` hides the badge.
 * The legacy version decided that by reading the computed style of the loading
 * screen, which meant the transport had an opinion about what the loading
 * screen was doing; that coupling is gone.
 *
 * `element` is null outside the browser client, where every method is a no-op.
 */
export const createConnectionIndicator = (element: HTMLElement | null): ConnectionIndicator => ({
  set: (state) => {
    if (element === null) return;
    // Assigning the whole class list also clears `hidden`, so any state other
    // than connected reveals the badge again without a second branch.
    element.className = `${BASE_CLASS} ${state}`;
    setText(element, LABELS[state]);
    if (state === 'connected') element.classList.add(HIDDEN_CLASS);
  },
  hide: () => {
    if (element === null) return;
    element.classList.add(HIDDEN_CLASS);
  },
});
