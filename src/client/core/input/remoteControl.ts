import type { Logger } from '../../../shared/types/logging';
import type { CommandDispatcher, PlayerCommand } from './commands';

/**
 * webOS remote buttons the player answers, indexed by `event.keyCode`.
 *
 * The TV reports its own buttons through the legacy `keyCode` field and nothing
 * else, which is why this table is numeric while the keyboard's is not. Several
 * buttons deliberately share a command: a remote may carry a dedicated
 * play/pause pair, transport keys, or only the direction pad, and the viewer
 * should not have to know which one this app was written for.
 */
export const WEBOS_KEY_COMMANDS: Readonly<Record<number, PlayerCommand>> = {
  13: 'play-pause', // OK
  415: 'play-pause', // Play
  19: 'play-pause', // Pause
  39: 'next', // Right
  417: 'next', // Fast forward
  37: 'previous', // Left
  412: 'previous', // Rewind
  38: 'speed-up', // Up
  40: 'speed-down', // Down
  403: 'toggle-crossfade', // Red
  404: 'toggle-blur', // Green
  405: 'show-info', // Yellow
  406: 'show-settings', // Blue
  413: 'stop', // Stop
  461: 'exit', // Back
};

/**
 * Binds a webOS remote to a dispatcher and returns the matching detach function.
 *
 * `onUnknownKey` is how the guide gets shown for a button this app has no use
 * for, which is what the legacy default branch did. The number keys it also
 * bound are gone: they set the speed to hardcoded presets that duplicated the
 * up and down buttons, ignored the configured speed range, and appeared nowhere
 * in the on-screen guide.
 */
export const attachRemoteControls = (options: {
  readonly target: Document;
  readonly dispatch: CommandDispatcher;
  readonly onUnknownKey?: () => void;
  readonly logger: Logger;
}): (() => void) => {
  const { target, dispatch, onUnknownKey, logger } = options;

  const onKeyDown = (event: KeyboardEvent): void => {
    const command = WEBOS_KEY_COMMANDS[event.keyCode];
    if (command === undefined) {
      logger.debug(`unbound remote key ${event.keyCode}`);
      // Left unprevented: the TV's own handling of a key we do not use is the
      // platform's business, not ours.
      if (onUnknownKey !== undefined) onUnknownKey();
      return;
    }

    event.preventDefault();
    logger.debug(`remote key ${event.keyCode} requested ${command}`);
    dispatch(command);
  };

  target.addEventListener('keydown', onKeyDown);
  logger.debug('remote controls attached');

  return () => {
    target.removeEventListener('keydown', onKeyDown);
    logger.debug('remote controls detached');
  };
};
