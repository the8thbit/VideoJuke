import { describeGamepadButton, describeKey } from '../../../shared/input/bindings';
import type { ControlAction, ControlsConfig } from '../../../shared/types/config';

/** The guide's sections, in the order and wording the static guide used. */
const GUIDE: readonly { readonly heading: string; readonly rows: readonly (readonly [ControlAction, string])[] }[] = [
  {
    heading: 'Playback',
    rows: [
      ['playPause', 'Play/Pause'],
      ['next', 'Next video'],
      ['previous', 'Previous video'],
      ['restart', 'Restart video'],
      ['toggleLoop', 'Toggle loop'],
      ['skipBackward', 'Skip backward'],
      ['skipForward', 'Skip forward'],
      ['speedUp', 'Speed up'],
      ['speedDown', 'Speed down'],
      ['resetSpeed', 'Reset speed'],
    ],
  },
  {
    heading: 'Audio & Effects',
    rows: [
      ['toggleMute', 'Toggle mute'],
      ['toggleCrossfade', 'Toggle crossfade'],
      ['toggleBlur', 'Toggle blur'],
    ],
  },
  { heading: 'Library', rows: [['toggleArchive', 'Flag for archive']] },
  {
    heading: 'Information',
    rows: [
      ['showInfo', 'Show video info'],
      ['showTitle', 'Show title only'],
      ['toggleDebug', 'Toggle debug overlay'],
      ['toggleOptions', 'Options and settings'],
      ['toggleControls', 'Toggle this list'],
    ],
  },
  { heading: 'Application', rows: [['exit', 'Quit']] },
];

/**
 * Redraws the controls overlay from the bindings in force, keyboard and
 * controller side by side, so the guide can never disagree with the keys. An
 * action bound to nothing on either is left out.
 */
export const renderControlsGuide = (container: HTMLElement, controls: ControlsConfig): void => {
  const document = container.ownerDocument;
  const create = (tag: string, className?: string, text?: string): HTMLElement => {
    const element = document.createElement(tag);
    if (className !== undefined) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  container.innerHTML = '';
  container.appendChild(create('h3', undefined, 'Controls'));
  const showGamepad = GUIDE.some((section) =>
    section.rows.some(([action]) => controls.gamepad[action].length > 0),
  );

  for (let index = 0; index < GUIDE.length; index += 1) {
    const section = GUIDE[index];
    if (section === undefined) continue;
    const block = create('div', 'controls-section');
    block.appendChild(create('h4', undefined, section.heading));
    let drawn = 0;
    for (let at = 0; at < section.rows.length; at += 1) {
      const row = section.rows[at];
      if (row === undefined) continue;
      const [action, label] = row;
      const keys = controls.keyboard[action].map(describeKey);
      const buttons = controls.gamepad[action].map(describeGamepadButton);
      if (keys.length === 0 && buttons.length === 0) continue;
      const item = create('div', 'control-item');
      if (keys.length > 0) item.appendChild(create('span', 'key', keys.join(' / ')));
      if (showGamepad && buttons.length > 0) {
        item.appendChild(create('span', 'key gamepad', buttons.join(' / ')));
      }
      item.appendChild(document.createTextNode(` - ${label}`));
      block.appendChild(item);
      drawn += 1;
    }
    if (drawn > 0) container.appendChild(block);
  }

  if (showGamepad) {
    container.appendChild(
      create(
        'div',
        'controls-note',
        'In the options panel a controller moves with the D-pad or left stick, presses with A, ' +
          'goes back with B, and jumps between sections with LB and RB.',
      ),
    );
  }
};
