import { buildBindingTable, canonicalKeyName, type BindingTable } from '../../../shared/input/bindings';
import type { ControlBindings } from '../../../shared/types/config';
import type { Logger } from '../../../shared/types/logging';
import {
  ACTION_COMMANDS,
  isPanelCommand,
  type CommandDispatcher,
  type PlayerCommand,
} from './commands';

/**
 * The command a key press asks for under `bindings`, or null for a key that is
 * not bound. `event.key` is compared in the same canonical spelling the config
 * is stored in, so `n` and `N` match a binding of `N`, and a space matches
 * `Space`.
 */
export const commandForKey = (table: BindingTable, key: string): PlayerCommand | null => {
  const name = canonicalKeyName(key);
  if (name === null) return null;
  const action = table[name.toLowerCase()];
  return action === undefined ? null : ACTION_COMMANDS[action];
};

/**
 * Whether a key press belongs to a form field rather than to the player:
 * typing "n" into the options panel must not skip a video.
 */
export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (target === null || typeof (target as Element).tagName !== 'string') return false;
  const element = target as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = ((element as HTMLInputElement).type || 'text').toLowerCase();
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
  }
  return element.isContentEditable === true;
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
  /** The keys in force, read on every press so a saved change applies at once. */
  readonly bindings: () => ControlBindings;
  /**
   * True while the options panel is open. Only the commands that close it are
   * passed on, and every other key is left to the panel and the browser.
   */
  readonly isSuspended?: () => boolean;
}): (() => void) => {
  const { target, dispatch, logger, isSuspended } = options;

  // Rebuilt only when the settings object changes, which is only on a save.
  let source: ControlBindings | null = null;
  let table: BindingTable = {};
  const currentTable = (): BindingTable => {
    const bindings = options.bindings();
    if (bindings !== source) {
      source = bindings;
      table = buildBindingTable(bindings);
    }
    return table;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // Something nearer the key - the options panel - has already answered it.
    if (event.defaultPrevented) return;
    if (isEditableTarget(event.target)) return;

    // A modifier means the key belongs to the browser or the OS, not to us.
    // Without this, Ctrl+R reloaded nothing and restarted the video instead,
    // Ctrl+P opened no print dialog and stepped backwards, and Cmd+Q neither
    // quit nor toggled the debug panel - every one of them swallowed by the
    // `preventDefault` below.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const command = commandForKey(currentTable(), event.key);
    if (command === null) return;
    if (isSuspended !== undefined && isSuspended() && !isPanelCommand(command)) return;

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
