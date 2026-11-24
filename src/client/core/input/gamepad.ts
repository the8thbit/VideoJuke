import { buildBindingTable, type BindingTable } from '../../../shared/input/bindings';
import type { ControlBindings } from '../../../shared/types/config';
import type { Logger } from '../../../shared/types/logging';
import type { PanelInput } from '../ui/optionsPanel';
import {
  ACTION_COMMANDS,
  isPanelCommand,
  type CommandDispatcher,
  type PlayerCommand,
} from './commands';

/**
 * The buttons of the browser's "standard" gamepad layout, by index, named as on
 * an Xbox controller. A controller the browser cannot map reports its buttons
 * in its own order; they are read the same way, which is the best that can be
 * done without knowing the device.
 */
const BUTTON_NAMES: readonly string[] = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'View',
  'Menu',
  'LS',
  'RS',
  'DpadUp',
  'DpadDown',
  'DpadLeft',
  'DpadRight',
  'Guide',
];

/** How far a stick must lean to count as pushed, and how far back to let go. */
const STICK_PRESS = 0.6;
const STICK_RELEASE = 0.35;
/** How far an analogue trigger must be pulled to count as pressed. */
const TRIGGER_PRESS = 0.5;

/** A held direction repeats after this long, and then this often. */
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 120;
const POLL_INTERVAL_MS = 16;

/**
 * The panel's own controller layout. Fixed rather than configurable, so a
 * binding saved by mistake can never leave the panel - the one place bindings
 * are changed - impossible to move around in.
 */
const PANEL_INPUTS: Readonly<Record<string, PanelInput>> = {
  DpadUp: 'up',
  DpadDown: 'down',
  DpadLeft: 'left',
  DpadRight: 'right',
  LeftStickUp: 'up',
  LeftStickDown: 'down',
  LeftStickLeft: 'left',
  LeftStickRight: 'right',
  A: 'activate',
  LB: 'previous-section',
  RB: 'next-section',
};

/** In the panel, B is "back": it closes the panel over a video. */
const PANEL_BACK_BUTTON = 'B';

/** Commands that make sense to repeat while their button is held. */
const REPEATING_COMMANDS: readonly PlayerCommand[] = [
  'speed-up',
  'speed-down',
  'skip-forward',
  'skip-backward',
];
const REPEATING_PANEL_INPUTS: readonly PanelInput[] = ['up', 'down', 'left', 'right'];

/** The parts of the browser's `Gamepad` this module reads. */
export interface GamepadLike {
  readonly index: number;
  readonly connected?: boolean;
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  readonly axes: readonly number[];
}

/**
 * The stick directions pushed on one axis pair. `held` is what was pushed on
 * the previous read: a stick has to come most of the way back before the same
 * direction counts again, so one that rests at the threshold cannot flicker.
 */
const stickDirections = (
  prefix: string,
  x: number,
  y: number,
  held: Readonly<Record<string, boolean>>,
): string[] => {
  const names: string[] = [];
  const check = (name: string, amount: number): void => {
    const threshold = held[name] === true ? STICK_RELEASE : STICK_PRESS;
    if (amount > threshold) names.push(name);
  };
  check(`${prefix}Left`, -x);
  check(`${prefix}Right`, x);
  check(`${prefix}Up`, -y);
  check(`${prefix}Down`, y);
  return names;
};

/** Every button and stick direction a controller has down right now. */
export const pressedNames = (
  pad: GamepadLike,
  held: Readonly<Record<string, boolean>> = {},
): string[] => {
  const names: string[] = [];
  for (let index = 0; index < pad.buttons.length && index < BUTTON_NAMES.length; index += 1) {
    const button = pad.buttons[index];
    if (button === undefined) continue;
    if (button.pressed || button.value > TRIGGER_PRESS) names.push(BUTTON_NAMES[index] as string);
  }
  const axis = (at: number): number => {
    const value = pad.axes[at];
    return typeof value === 'number' && isFinite(value) ? value : 0;
  };
  return names
    .concat(stickDirections('LeftStick', axis(0), axis(1), held))
    .concat(stickDirections('RightStick', axis(2), axis(3), held));
};

/** What one press is routed to: a player command, or the panel. */
type Route =
  | { readonly kind: 'command'; readonly command: PlayerCommand }
  | { readonly kind: 'panel'; readonly input: PanelInput };

interface Hold {
  readonly route: Route;
  readonly panelOpen: boolean;
  nextRepeat: number;
}

export interface GamepadInputOptions {
  readonly dispatch: CommandDispatcher;
  readonly logger: Logger;
  /** The buttons in force, read on every press so a saved change applies at once. */
  readonly bindings: () => ControlBindings;
  readonly isPanelOpen: () => boolean;
  readonly navigatePanel: (input: PanelInput) => void;
}

export interface GamepadInput {
  /** Reads the controllers' state once and acts on whatever changed. */
  readonly update: (pads: readonly (GamepadLike | null)[], now: number) => void;
}

/**
 * Turns controller state, read over and over, into commands. The browser has no
 * events for buttons, only a snapshot to poll, so a press is a name that is down
 * now and was not on the previous read.
 */
export const createGamepadInput = (options: GamepadInputOptions): GamepadInput => {
  const { dispatch, logger, isPanelOpen, navigatePanel } = options;

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

  /** Per controller: what was down on the last read, and what is repeating. */
  const previous: Record<number, Record<string, boolean>> = {};
  const holds: Record<number, Record<string, Hold>> = {};

  const route = (name: string, panelOpen: boolean): Route | null => {
    if (panelOpen) {
      const input = PANEL_INPUTS[name];
      if (input !== undefined) return { kind: 'panel', input };
      if (name === PANEL_BACK_BUTTON) return { kind: 'command', command: 'toggle-options' };
    }
    const action = currentTable()[name.toLowerCase()];
    if (action === undefined) return null;
    const command = ACTION_COMMANDS[action];
    // The panel has the controller; only the ways out of it get through.
    if (panelOpen && !isPanelCommand(command)) return null;
    return { kind: 'command', command };
  };

  const run = (target: Route, name: string): void => {
    if (target.kind === 'panel') {
      navigatePanel(target.input);
      return;
    }
    logger.debug(`controller ${name} requested ${target.command}`);
    dispatch(target.command);
  };

  const repeats = (target: Route): boolean =>
    target.kind === 'panel'
      ? REPEATING_PANEL_INPUTS.indexOf(target.input) !== -1
      : REPEATING_COMMANDS.indexOf(target.command) !== -1;

  const update = (pads: readonly (GamepadLike | null)[], now: number): void => {
    const seen: Record<number, boolean> = {};
    for (let index = 0; index < pads.length; index += 1) {
      const pad = pads[index];
      if (pad === null || pad === undefined || pad.connected === false) continue;
      seen[pad.index] = true;
      const before = previous[pad.index] ?? {};
      const padHolds = holds[pad.index] ?? {};
      holds[pad.index] = padHolds;
      const down: Record<string, boolean> = {};
      const names = pressedNames(pad, before);

      for (let at = 0; at < names.length; at += 1) {
        const name = names[at] as string;
        down[name] = true;
        const panelOpen = isPanelOpen();
        if (before[name] !== true) {
          const target = route(name, panelOpen);
          if (target === null) continue;
          run(target, name);
          if (repeats(target)) {
            padHolds[name] = { route: target, panelOpen, nextRepeat: now + REPEAT_DELAY_MS };
          }
          continue;
        }
        const hold = padHolds[name];
        // A press that opened or closed the panel does not go on repeating in
        // the other one: the arrow that skipped would start moving the focus.
        if (hold === undefined || hold.panelOpen !== panelOpen) continue;
        if (now >= hold.nextRepeat) {
          hold.nextRepeat = now + REPEAT_INTERVAL_MS;
          run(hold.route, name);
        }
      }

      const heldNames = Object.keys(padHolds);
      for (let at = 0; at < heldNames.length; at += 1) {
        const name = heldNames[at] as string;
        if (down[name] !== true) delete padHolds[name];
      }
      previous[pad.index] = down;
    }

    // A controller that went away takes its held buttons with it.
    const known = Object.keys(previous);
    for (let index = 0; index < known.length; index += 1) {
      const key = Number(known[index]);
      if (seen[key] === true) continue;
      delete previous[key];
      delete holds[key];
    }
  };

  return { update };
};

/**
 * Polls the browser's controllers and returns the matching detach function.
 *
 * Xbox controllers come through the browser's standard mapping on Windows,
 * whether wired, on the wireless adapter or over Bluetooth. A browser only
 * reveals a controller once a button has been pressed with the page focused.
 */
export const attachGamepadControls = (
  options: GamepadInputOptions & { readonly navigator: Navigator },
): (() => void) => {
  const { navigator, logger } = options;
  if (typeof navigator.getGamepads !== 'function') {
    logger.info('this browser has no controller support');
    return () => undefined;
  }

  const input = createGamepadInput(options);
  const timer = setInterval(() => {
    let pads: readonly (GamepadLike | null)[];
    try {
      pads = navigator.getGamepads() as unknown as readonly (GamepadLike | null)[];
    } catch {
      // A page denied gamepad access by policy throws; there is nothing to read.
      return;
    }
    input.update(pads, Date.now());
  }, POLL_INTERVAL_MS);
  logger.debug('controller input attached');

  return () => {
    clearInterval(timer);
    logger.debug('controller input detached');
  };
};
