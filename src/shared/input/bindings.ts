import {
  CONTROL_ACTIONS,
  GAMEPAD_BUTTONS,
  type ControlAction,
  type ControlBindings,
} from '../types/config';

/*
 * Names for keys and controller buttons, shared by the config file, the options
 * panel and the input handlers so all three agree on what `Space` or `DpadUp`
 * means. Written without Map, Set or the ES2015 string methods, because the TV
 * build compiles this file to ES5.
 */

/**
 * Key names written differently from how the browser reports them, by their
 * lower-cased spelling. A space and a comma get words because a binding list is
 * edited as comma-separated text, where neither would survive.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  ' ': 'Space',
  space: 'Space',
  spacebar: 'Space',
  ',': 'Comma',
  comma: 'Comma',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  mediaplaypause: 'MediaPlayPause',
  mediatracknext: 'MediaTrackNext',
  mediatrackprevious: 'MediaTrackPrevious',
  mediastop: 'MediaStop',
};

/**
 * The one spelling of a key name, or null for nothing at all.
 *
 * A single character is upper-cased, so `n` and `N` are the same binding: the
 * keyboard handler compares what was pressed the same way, and Shift is not
 * told apart. Anything else not listed above is kept as written, which is how a
 * key this file has never heard of - `F5`, `AudioVolumeUp` - can still be bound
 * by the name the browser gives it.
 */
export const canonicalKeyName = (raw: string): string | null => {
  if (raw === ' ') return 'Space';
  const trimmed = raw.replace(/^\s+|\s+$/g, '');
  if (trimmed === '') return null;
  const alias = KEY_ALIASES[trimmed.toLowerCase()];
  if (alias !== undefined) return alias;
  if (trimmed.length === 1) return trimmed.toUpperCase();
  if (/^f\d{1,2}$/i.test(trimmed)) return trimmed.toUpperCase();
  return trimmed;
};

/** Other names people know controller buttons by, lower-cased. */
const BUTTON_ALIASES: Readonly<Record<string, string>> = {
  start: 'Menu',
  options: 'Menu',
  back: 'View',
  select: 'View',
  share: 'View',
  home: 'Guide',
  xbox: 'Guide',
  l1: 'LB',
  r1: 'RB',
  l2: 'LT',
  r2: 'RT',
  l3: 'LS',
  r3: 'RS',
  up: 'DpadUp',
  down: 'DpadDown',
  left: 'DpadLeft',
  right: 'DpadRight',
};

/** The one spelling of a controller button, or null for a name it does not have. */
export const canonicalGamepadButton = (raw: string): string | null => {
  const lower = raw.replace(/^\s+|\s+$/g, '').toLowerCase();
  if (lower === '') return null;
  const alias = BUTTON_ALIASES[lower];
  if (alias !== undefined) return alias;
  for (let index = 0; index < GAMEPAD_BUTTONS.length; index += 1) {
    const name = GAMEPAD_BUTTONS[index] as string;
    if (name.toLowerCase() === lower) return name;
  }
  return null;
};

/** Which action each bound name triggers, keyed by the lower-cased name. */
export type BindingTable = Readonly<Record<string, ControlAction>>;

/**
 * Inverts a set of bindings for lookup. A name bound twice goes to the action
 * listed first, which is the same choice `findConflicts` reports.
 */
export const buildBindingTable = (bindings: ControlBindings): BindingTable => {
  const table: Record<string, ControlAction> = {};
  for (let index = 0; index < CONTROL_ACTIONS.length; index += 1) {
    const action = CONTROL_ACTIONS[index] as ControlAction;
    const names = bindings[action];
    for (let at = 0; at < names.length; at += 1) {
      const key = (names[at] as string).toLowerCase();
      if (table[key] === undefined) table[key] = action;
    }
  }
  return table;
};

export interface BindingConflict {
  readonly name: string;
  /** The action that gets the name. */
  readonly winner: ControlAction;
  /** The action listed later, which never sees it. */
  readonly loser: ControlAction;
}

/** Every name bound to more than one action. */
export const findConflicts = (bindings: ControlBindings): readonly BindingConflict[] => {
  const owner: Record<string, ControlAction> = {};
  const conflicts: BindingConflict[] = [];
  for (let index = 0; index < CONTROL_ACTIONS.length; index += 1) {
    const action = CONTROL_ACTIONS[index] as ControlAction;
    const names = bindings[action];
    for (let at = 0; at < names.length; at += 1) {
      const name = names[at] as string;
      const key = name.toLowerCase();
      const first = owner[key];
      if (first === undefined) owner[key] = action;
      else if (first !== action) conflicts.push({ name, winner: first, loser: action });
    }
  }
  return conflicts;
};

/** How a key name is shown to a person: arrows as arrows, the rest as named. */
export const describeKey = (name: string): string => {
  if (name === 'ArrowUp') return '↑';
  if (name === 'ArrowDown') return '↓';
  if (name === 'ArrowLeft') return '←';
  if (name === 'ArrowRight') return '→';
  if (name === 'Escape') return 'Esc';
  if (name === 'Comma') return ',';
  return name;
};

/** How a controller button is shown to a person. */
export const describeGamepadButton = (name: string): string => {
  const directions: Readonly<Record<string, string>> = {
    Up: '↑',
    Down: '↓',
    Left: '←',
    Right: '→',
  };
  const match = /^(Dpad|LeftStick|RightStick)(Up|Down|Left|Right)$/.exec(name);
  if (match === null) return name;
  const prefix = match[1] === 'Dpad' ? 'D-pad' : match[1] === 'LeftStick' ? 'Left stick' : 'Right stick';
  return `${prefix} ${directions[match[2] as string] as string}`;
};
