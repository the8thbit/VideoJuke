import type { Logger } from '../../../shared/types/logging';
import type { CommandDispatcher, PlayerCommand } from './commands';

/**
 * Keys the player answers, indexed by the lower-cased `event.key`.
 *
 * Keeping the bindings as data rather than as a switch means the table can be
 * read by anything that wants to describe the controls, and it is the reason a
 * key is looked up exactly once per event instead of being compared eighteen
 * times.
 */
export const KEY_COMMANDS: Readonly<Record<string, PlayerCommand>> = {
  ' ': 'play-pause',
  n: 'next',
  p: 'previous',
  r: 'restart',
  l: 'toggle-loop',
  m: 'toggle-mute',
  f: 'toggle-crossfade',
  b: 'toggle-blur',
  a: 'toggle-archive',
  arrowup: 'speed-up',
  arrowdown: 'speed-down',
  '0': 'reset-speed',
  arrowright: 'skip-forward',
  arrowleft: 'skip-backward',
  i: 'show-info',
  t: 'show-title',
  q: 'toggle-debug',
  '?': 'toggle-controls',
  '/': 'toggle-controls',
  escape: 'exit',
};

/**
 * Binds the keyboard to a dispatcher and returns the matching detach function.
 *
 * The legacy version registered its context menu and drag handlers with inline
 * arrow functions it kept no reference to, so `cleanup` removed the key handler
 * and left the other three attached to the document for the life of the page.
 */
export const attachKeyboardControls = (options: {
  readonly target: Document;
  readonly dispatch: CommandDispatcher;
  readonly logger: Logger;
}): (() => void) => {
  const { target, dispatch, logger } = options;

  const onKeyDown = (event: KeyboardEvent): void => {
    // A modifier means the key belongs to the browser or the OS, not to us.
    // Without this, Ctrl+R reloaded nothing and restarted the video instead,
    // Ctrl+P opened no print dialog and stepped backwards, and Cmd+Q neither
    // quit nor toggled the debug panel - every one of them swallowed by the
    // `preventDefault` below.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const command = KEY_COMMANDS[event.key.toLowerCase()];
    if (command === undefined) return;

    // Only a bound key is swallowed, so the browser's own shortcuts still work.
    event.preventDefault();
    logger.debug(`key ${event.key} requested ${command}`);
    dispatch(command);
  };

  // A jukebox on a screen is not a document to be dragged into or right-clicked.
  const suppress = (event: Event): void => {
    event.preventDefault();
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('contextmenu', suppress);
  target.addEventListener('dragover', suppress);
  target.addEventListener('drop', suppress);
  logger.debug('keyboard controls attached');

  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('contextmenu', suppress);
    target.removeEventListener('dragover', suppress);
    target.removeEventListener('drop', suppress);
    logger.debug('keyboard controls detached');
  };
};
