import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyConfigChange } from '../src/shared/config/changeImpact';
import { DEFAULT_CONFIG } from '../src/shared/config/defaults';
import { normalizeConfig } from '../src/shared/config/normalize';
import {
  buildBindingTable,
  canonicalGamepadButton,
  canonicalKeyName,
  describeGamepadButton,
  findConflicts,
} from '../src/shared/input/bindings';
import { CONTROL_ACTIONS, toClientConfig, type ControlBindings } from '../src/shared/types/config';
import type { PlayerCommand } from '../src/client/core/input/commands';
import { createGamepadInput, pressedNames, type GamepadLike } from '../src/client/core/input/gamepad';
import { attachKeyboardControls, commandForKey } from '../src/client/core/input/keyboard';
import type { PanelInput } from '../src/client/core/ui/optionsPanel';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const withDirectory = (extra: Record<string, unknown>): Record<string, unknown> => ({
  directories: ['X:/videos'],
  ...extra,
});

describe('key and button names', () => {
  it('spells a key one way however it is written', () => {
    assert.equal(canonicalKeyName(' '), 'Space');
    assert.equal(canonicalKeyName('space'), 'Space');
    assert.equal(canonicalKeyName('n'), 'N');
    assert.equal(canonicalKeyName(' N '), 'N');
    assert.equal(canonicalKeyName(','), 'Comma');
    assert.equal(canonicalKeyName('esc'), 'Escape');
    assert.equal(canonicalKeyName('up'), 'ArrowUp');
    assert.equal(canonicalKeyName('arrowleft'), 'ArrowLeft');
    assert.equal(canonicalKeyName('f5'), 'F5');
    assert.equal(canonicalKeyName('?'), '?');
    assert.equal(canonicalKeyName('AudioVolumeUp'), 'AudioVolumeUp', 'an unknown name is kept');
    assert.equal(canonicalKeyName('   '), null);
  });

  it('knows a controller button by its Xbox name or a common other one', () => {
    assert.equal(canonicalGamepadButton('a'), 'A');
    assert.equal(canonicalGamepadButton('dpadup'), 'DpadUp');
    assert.equal(canonicalGamepadButton('Start'), 'Menu');
    assert.equal(canonicalGamepadButton('back'), 'View');
    assert.equal(canonicalGamepadButton('R1'), 'RB');
    assert.equal(canonicalGamepadButton('leftstickright'), 'LeftStickRight');
    assert.equal(canonicalGamepadButton('Z'), null);
  });

  it('describes stick and pad directions in words a person reads', () => {
    assert.equal(describeGamepadButton('DpadLeft'), 'D-pad \u2190');
    assert.equal(describeGamepadButton('RightStickUp'), 'Right stick \u2191');
    assert.equal(describeGamepadButton('LB'), 'LB');
  });
});

describe('controls settings', () => {
  it('binds every action on both devices by default, without a clash', () => {
    for (const action of CONTROL_ACTIONS) {
      assert.ok(Array.isArray(DEFAULT_CONFIG.controls.keyboard[action]), action);
      assert.ok(Array.isArray(DEFAULT_CONFIG.controls.gamepad[action]), action);
    }
    assert.deepEqual(findConflicts(DEFAULT_CONFIG.controls.keyboard), []);
    assert.deepEqual(findConflicts(DEFAULT_CONFIG.controls.gamepad), []);
    for (const names of Object.values(DEFAULT_CONFIG.controls.gamepad)) {
      for (const name of names) assert.equal(canonicalGamepadButton(name), name);
    }
  });

  it('reaches the client, which is where the keys are read', () => {
    assert.deepEqual(toClientConfig(DEFAULT_CONFIG).controls, DEFAULT_CONFIG.controls);
  });

  it('replaces one action and leaves the rest at their defaults', () => {
    const { config, issues } = normalizeConfig(
      withDirectory({ controls: { keyboard: { next: ['j', 'PageDown'] }, gamepad: { next: ['xbox'] } } }),
    );
    assert.deepEqual(issues, []);
    assert.deepEqual(config.controls.keyboard.next, ['J', 'PageDown']);
    assert.deepEqual(config.controls.keyboard.previous, DEFAULT_CONFIG.controls.keyboard.previous);
    assert.deepEqual(config.controls.gamepad.next, ['Guide']);
  });

  it('drops a button the controller does not have, and says so', () => {
    const { config, issues } = normalizeConfig(
      withDirectory({ controls: { gamepad: { next: ['RB', 'Turbo'] } } }),
    );
    assert.deepEqual(config.controls.gamepad.next, ['RB']);
    assert.equal(issues.length, 1);
    assert.match(issues[0]?.path ?? '', /controls\.gamepad\.next/);
  });

  it('reports a key bound twice, and lets the first action have it', () => {
    const { config, issues } = normalizeConfig(
      withDirectory({ controls: { keyboard: { restart: ['N'] } } }),
    );
    assert.ok(issues.some((issue) => /N is also bound to next/.test(issue.message)));
    assert.equal(buildBindingTable(config.controls.keyboard).n, 'next');
  });

  it('unbinds an action given an empty list', () => {
    const { config } = normalizeConfig(withDirectory({ controls: { keyboard: { exit: [] } } }));
    assert.deepEqual(config.controls.keyboard.exit, []);
  });

  it('applies without reindexing or requeueing anything', () => {
    const next = normalizeConfig(
      withDirectory({ controls: { keyboard: { next: ['J'] } } }),
    ).config;
    const previous = normalizeConfig(withDirectory({})).config;
    assert.equal(classifyConfigChange(previous, next), 'none');
  });
});

describe('keyboard bindings', () => {
  const table = buildBindingTable(DEFAULT_CONFIG.controls.keyboard);

  it('matches what the browser reports against the stored names', () => {
    assert.equal(commandForKey(table, ' '), 'play-pause');
    assert.equal(commandForKey(table, 'n'), 'next');
    assert.equal(commandForKey(table, 'N'), 'next');
    assert.equal(commandForKey(table, 'ArrowUp'), 'speed-up');
    assert.equal(commandForKey(table, 'Escape'), 'exit');
    assert.equal(commandForKey(table, '?'), 'toggle-controls');
    assert.equal(commandForKey(table, 'z'), null);
  });

  /** A document that hands its listeners straight to the test. */
  const fakeDocument = (): {
    target: Document;
    press: (key: string) => boolean;
  } => {
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    const target = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        (listeners[type] ??= []).push(listener);
      },
      removeEventListener: () => undefined,
    } as unknown as Document;
    const press = (key: string): boolean => {
      let prevented = false;
      const event = {
        key,
        target: null,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        get defaultPrevented() {
          return prevented;
        },
        preventDefault: () => {
          prevented = true;
        },
      };
      for (const listener of listeners.keydown ?? []) listener(event);
      return prevented;
    };
    return { target, press };
  };

  it('follows a change of bindings without being attached again', () => {
    const { target, press } = fakeDocument();
    const sent: PlayerCommand[] = [];
    let bindings: ControlBindings = DEFAULT_CONFIG.controls.keyboard;
    attachKeyboardControls({
      target,
      dispatch: (command) => sent.push(command),
      logger: silentLogger,
      bindings: () => bindings,
    });

    press('n');
    bindings = { ...bindings, next: ['J'] };
    assert.equal(press('n'), false, 'an unbound key is left to the browser');
    press('j');
    assert.deepEqual(sent, ['next', 'next']);
  });
});

describe('controller input', () => {
  const NO_BUTTON = { pressed: false, value: 0 };

  /** A standard-layout controller with the named buttons down. */
  const pad = (down: readonly string[] = [], axes: readonly number[] = [0, 0, 0, 0]): GamepadLike => {
    const order = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'DpadUp', 'DpadDown', 'DpadLeft', 'DpadRight', 'Guide'];
    return {
      index: 0,
      connected: true,
      buttons: order.map((name) => (down.includes(name) ? { pressed: true, value: 1 } : NO_BUTTON)),
      axes,
    };
  };

  const setup = (panelOpen = false) => {
    const sent: PlayerCommand[] = [];
    const moved: PanelInput[] = [];
    const state = { panelOpen, bindings: DEFAULT_CONFIG.controls.gamepad as ControlBindings };
    const input = createGamepadInput({
      dispatch: (command) => sent.push(command),
      logger: silentLogger,
      bindings: () => state.bindings,
      isPanelOpen: () => state.panelOpen,
      navigatePanel: (to) => moved.push(to),
    });
    return { sent, moved, state, input };
  };

  it('reads triggers and stick directions as buttons', () => {
    const triggers = pad();
    const pulled = { ...triggers, buttons: triggers.buttons.map((button, index) => (index === 7 ? { pressed: false, value: 0.8 } : button)) };
    assert.deepEqual(pressedNames(pulled), ['RT']);
    assert.deepEqual(pressedNames(pad([], [-0.9, 0, 0, 0.7])), ['LeftStickLeft', 'RightStickDown']);
  });

  it('acts once per press, not once per read', () => {
    const { sent, input } = setup();
    input.update([pad(['A'])], 0);
    input.update([pad(['A'])], 16);
    input.update([pad(['A'])], 2000);
    input.update([pad()], 2016);
    input.update([pad(['RB'])], 2032);
    assert.deepEqual(sent, ['play-pause', 'next']);
  });

  it('repeats a held skip, after a pause', () => {
    const { sent, input } = setup();
    input.update([pad(['DpadRight'])], 0);
    input.update([pad(['DpadRight'])], 300);
    assert.equal(sent.length, 1, 'no repeat before the delay');
    input.update([pad(['DpadRight'])], 400);
    input.update([pad(['DpadRight'])], 520);
    assert.deepEqual(sent, ['skip-forward', 'skip-forward', 'skip-forward']);
  });

  it('drives the panel while it is open, and lets only the ways out through', () => {
    const { sent, moved, input } = setup(true);
    input.update([pad(['DpadDown'])], 0);
    input.update([pad()], 16);
    input.update([pad([], [0, -0.9, 0, 0])], 32);
    input.update([pad()], 48);
    input.update([pad(['A'])], 64);
    input.update([pad(['RB'])], 80);
    input.update([pad(['X'])], 96);
    input.update([pad(['B'])], 112);
    input.update([pad(['Menu'])], 128);
    assert.deepEqual(moved, ['down', 'up', 'activate', 'next-section']);
    assert.deepEqual(sent, ['toggle-options', 'toggle-options']);
  });

  it('keeps a stick that rests at the edge from flickering', () => {
    const { sent, input } = setup();
    input.update([pad([], [0, -0.7, 0, 0])], 0);
    input.update([pad([], [0, -0.5, 0, 0])], 16);
    input.update([pad([], [0, -0.7, 0, 0])], 32);
    assert.deepEqual(sent, [], 'the left stick is bound to nothing during playback');

    const { moved, input: menu } = setup(true);
    menu.update([pad([], [0, -0.7, 0, 0])], 0);
    menu.update([pad([], [0, -0.5, 0, 0])], 16);
    menu.update([pad([], [0, -0.7, 0, 0])], 32);
    assert.deepEqual(moved, ['up']);
  });

  it('does not carry a held direction from the video into the panel', () => {
    const { sent, moved, state, input } = setup();
    input.update([pad(['DpadUp'])], 0);
    state.panelOpen = true;
    input.update([pad(['DpadUp'])], 1000);
    assert.deepEqual(sent, ['speed-up']);
    assert.deepEqual(moved, []);
  });

  it('follows rebinding', () => {
    const { sent, state, input } = setup();
    state.bindings = { ...state.bindings, toggleArchive: ['Y'], toggleMute: [] };
    input.update([pad(['Y'])], 0);
    assert.deepEqual(sent, ['toggle-archive']);
  });
});
