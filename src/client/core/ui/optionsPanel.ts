import { DEFAULT_CONFIG } from '../../../shared/config/defaults';
import { requiresRestart } from '../../../shared/config/patch';
import {
  AUDIO_CODEC_NAMES,
  LENGTH_BIAS_DIRECTIONS,
  LOG_LEVEL_NAMES,
  NORMALIZATION_PRESET_NAMES,
  PERFORMANCE_MODES,
  PROCESS_PRIORITIES,
  type ConfigIssue,
  type DirectoryConfig,
} from '../../../shared/types/config';
import type { Logger } from '../../../shared/types/logging';
import type { PlayerApi } from '../../../shared/types/protocol';
import { attemptAsync } from '../../../shared/types/result';
import type { ConfigPatch, EditableConfig, LogRecord } from '../../../shared/types/settings';
import {
  INITIAL_PIPELINE_STATE,
  type PhaseState,
  type PipelineState,
  type ServiceStatus,
} from '../../../shared/types/status';
import { formatPercent } from '../../../shared/util/format';
import { isPlainObject, readPath } from '../../../shared/util/objects';
import { setClass } from '../dom/elements';
import { isEditableTarget } from '../input/keyboard';

/**
 * `start` is the screen the app boots into: nothing is playing, and Play is
 * what leaves it. `playback` is the same panel opened over a video with the
 * options key, where Play becomes the way back to the video.
 */
export type PanelMode = 'start' | 'playback';

export interface OptionsPanelDeps {
  readonly root: Document;
  readonly container: HTMLElement;
  /** Shown over everything while a settings change is being worked in. */
  readonly banner: HTMLElement;
  readonly api: Pick<
    PlayerApi,
    | 'startIndex'
    | 'startQueue'
    | 'setAutoQueue'
    | 'setAutoPlay'
    | 'getEditableConfig'
    | 'saveConfig'
    | 'getRecentLog'
  >;
  readonly logger: Logger;
  /** Play was pressed with a queue ready to play from. */
  readonly onPlay: () => void;
  /** The way back to the video, in playback mode. */
  readonly onClose: () => void;
  /** A save went through; the app re-reads the settings it plays with. */
  readonly onSaved: () => void;
  /** Only where there is a server to change, i.e. the TV. */
  readonly onChangeServer?: () => void;
  /**
   * Whether the arrow keys move between controls. The TV has a direction pad
   * and nothing else, while a keyboard has Tab and needs its arrows for text.
   */
  readonly arrowNavigation: boolean;
  /**
   * A follower plays whatever the leading screen plays, so it can start the
   * moment it is asked: there is no queue of its own to wait for.
   */
  readonly playAlwaysReady: boolean;
}

export interface OptionsPanel {
  readonly show: () => void;
  readonly hide: () => void;
  readonly isVisible: () => boolean;
  readonly setMode: (mode: PanelMode) => void;
  readonly applyPipeline: (state: PipelineState) => void;
  readonly applyStatus: (status: ServiceStatus) => void;
  /** The settings changed somewhere else; re-read them unless mid-edit. */
  readonly notifyRevision: (revision: number) => void;
  /** A line under the steps, for what the app itself has to say. */
  readonly showMessage: (message: string, isError: boolean) => void;
  readonly cleanup: () => void;
}

const HIDDEN_CLASS = 'hidden';
/** How often the log is re-read while the panel is open. */
const LOG_POLL_INTERVAL_MS = 2000;
/** Rows kept in the log; the server keeps the same number. */
const LOG_ROW_LIMIT = 200;

const KEY_UP = 38;
const KEY_DOWN = 40;
const KEY_LEFT = 37;
const KEY_RIGHT = 39;
const KEY_ENTER = 13;
const KEY_ESCAPE = 27;

/** The top-level sections, most-used first; anything new is appended. */
const SECTION_ORDER: readonly (readonly [string, string])[] = [
  ['directories', 'Video directories'],
  ['selection', 'Selection'],
  ['images', 'Images'],
  ['files', 'Files and scanning'],
  ['startup', 'Startup'],
  ['video', 'Queue and history'],
  ['crossfade', 'Crossfade'],
  ['blur', 'Blur'],
  ['playback', 'Playback controls'],
  ['ui', 'On-screen messages'],
  ['audio', 'Audio'],
  ['performance', 'Transcoding performance'],
  ['seasonalDirectories', 'Seasonal directories'],
  ['timeouts', 'Timeouts (milliseconds)'],
  ['retries', 'Retries'],
  ['system', 'System'],
  ['network', 'Network'],
];

/** Sections open when the panel is first drawn. */
const OPEN_SECTIONS: readonly string[] = ['directories', 'selection', 'images', 'files', 'startup'];

/** Fields the panel never shows. The token is the key to the API itself. */
const HIDDEN_PATHS: readonly string[] = ['network.server.authToken'];

/** Text-valued settings that only take one of a few values. */
const choicesFor = (path: string): readonly string[] | null => {
  if (path === 'selection.lengthBias.favor') return LENGTH_BIAS_DIRECTIONS;
  if (path === 'performance.mode') return PERFORMANCE_MODES;
  if (path === 'audio.normalization.strength') return NORMALIZATION_PRESET_NAMES;
  if (path === 'system.logLevel') return LOG_LEVEL_NAMES;
  if (path === 'audio.codecPreferences.multichannel') return AUDIO_CODEC_NAMES;
  if (path === 'audio.codecPreferences.stereo') return AUDIO_CODEC_NAMES;
  if (/(^|\.)priority$/.test(path)) return PROCESS_PRIORITIES;
  return null;
};

const HINTS: Readonly<Record<string, string>> = {
  directories:
    'The bias sets how often a directory is chosen against the others: 2 counts twice as ' +
    'much as 1, and 0 means only once the others have nothing left. Whether a bigger ' +
    'directory also comes round more often is set under Selection.',
  'selection.scaleBiasByDirectorySize':
    'On: a directory is chosen in proportion to its bias times the videos it holds, so with ' +
    'equal biases every video is equally likely. Off: with equal biases every directory is ' +
    'equally likely, however many videos it holds.',
  'selection.lengthBias.enabled':
    'Make videos more or less likely to be picked by their length. Lengths are measured ' +
    'while indexing, so switching this on the first time re-indexes the library.',
  'selection.lengthBias.favor': 'Which end of the length range is favoured.',
  'selection.lengthBias.maxRatio':
    'How many times likelier the most favoured length is than the least favoured one.',
  'images.enabled':
    'Index pictures as well as videos. Each one is shown for the display duration and ' +
    'then playback moves on.',
  'images.displayDuration': 'How long each picture stays on screen, in milliseconds.',
  'images.extensions':
    'An animated WebP is shown as its first frame. Changing this list re-indexes the library.',
  'files.recursive':
    'Also index everything in the subfolders of each directory. Off, only the files ' +
    'directly inside it are indexed; add a subfolder as a directory of its own to play it.',
  'files.supportedVideoExtensions': 'Changing this list re-indexes the library.',
  'startup.autoQueueAfterIndex':
    'The default for each new session. The toggle on the Queue button changes only this one.',
  'startup.autoPlayAfterQueue':
    'The default for each new session. The toggle on the Play button changes only this one.',
  'video.preprocessedQueueSize': 'Transcoded videos the server keeps ready.',
  'video.playbackQueueSize': 'Videos each screen keeps queued ahead of the one playing.',
  seasonalDirectories:
    'Edited as JSON: a list of { "directory", "likelihood", "conditions" } entries.',
};

/** `preprocessedQueueSize` becomes "Preprocessed queue size". */
const humanize = (key: string): string => {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

const joinPath = (parent: string, key: string): string =>
  parent === '' ? key : `${parent}.${key}`;

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Nests `{ "a.b": 1 }` into `{ a: { b: 1 } }`, which is what a save takes. */
const toPatch = (changes: Readonly<Record<string, unknown>>): ConfigPatch => {
  const patch: Record<string, unknown> = {};
  const paths = Object.keys(changes);
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index] as string;
    const segments = path.split('.');
    let cursor = patch;
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const segment = segments[depth] as string;
      const existing = cursor[segment];
      const next: Record<string, unknown> = isPlainObject(existing)
        ? (existing as Record<string, unknown>)
        : {};
      cursor[segment] = next;
      cursor = next;
    }
    cursor[segments[segments.length - 1] as string] = changes[path];
  }
  return patch;
};

/** `12:34:56` out of an ISO timestamp, which is all a scrolling log needs. */
const clockTime = (timestamp: string): string =>
  timestamp.length >= 19 ? timestamp.slice(11, 19) : timestamp;

interface StepView {
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly fill: HTMLElement;
}

/** What a step button does right now, and what it says. */
interface StepAction {
  readonly label: string;
  readonly enabled: boolean;
  /** True when the button is standing in as an auto toggle. */
  readonly toggle: boolean;
  readonly pressed: boolean;
  readonly run: (() => void) | null;
}

/**
 * The start screen and the options panel, which are the same thing.
 *
 * Three steps across the top - index, queue, play - then every setting, then the
 * server's recent warnings and errors. A step that is not ready yet turns its
 * button into an auto toggle for the session ("queue as soon as the index is
 * done"), which is separate from the `startup` settings below it: those are only
 * where each new session begins.
 *
 * The form is drawn from the shape of `DEFAULT_CONFIG` rather than written out
 * field by field, so a setting added to the configuration appears here without
 * anyone remembering to add it. Only the few fields that need more than an input
 * - the directory list, the seasonal JSON, the choices - are special-cased.
 */
export const createOptionsPanel = (deps: OptionsPanelDeps): OptionsPanel => {
  const { root, container, banner, api, logger } = deps;

  let visible = false;
  let mode: PanelMode = 'start';
  let pipeline: PipelineState = INITIAL_PIPELINE_STATE;
  let status: ServiceStatus | null = null;
  let loaded: EditableConfig | null = null;
  let loading = false;
  let saving = false;
  /** Changed fields by dotted path, holding the value to save. */
  let changes: Record<string, unknown> = {};
  /** Fields whose input cannot be read as a value, by dotted path. */
  let invalid: Record<string, string> = {};
  /** Each field's row, so issues from a refused save can be shown beside it. */
  let rows: Record<string, HTMLElement> = {};
  let lastLogSequence = 0;
  let logTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const create = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const element = root.createElement(tag);
    if (className !== undefined) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  // --- Skeleton -------------------------------------------------------------

  container.innerHTML = '';
  const content = create('div', 'options-content');
  container.appendChild(content);

  const header = create('div', 'options-header');
  const title = create('h2', 'options-title', 'VideoJuke');
  header.appendChild(title);
  content.appendChild(header);

  const steps = create('div', 'options-steps');
  content.appendChild(steps);

  const makeStep = (name: string): StepView => {
    const card = create('div', 'options-step');
    const button = create('button', 'options-step-button', name);
    button.type = 'button';
    const bar = create('div', 'options-step-bar');
    const fill = create('div', 'options-step-fill');
    bar.appendChild(fill);
    const stepStatus = create('div', 'options-step-status');
    card.appendChild(button);
    card.appendChild(bar);
    card.appendChild(stepStatus);
    steps.appendChild(card);
    return { button, status: stepStatus, fill };
  };

  const indexStep = makeStep('Index');
  const queueStep = makeStep('Queue');
  const playStep = makeStep('Play');

  const message = create('div', 'options-message hidden');
  content.appendChild(message);

  const extraActions = create('div', 'options-extra');
  content.appendChild(extraActions);
  if (deps.onChangeServer !== undefined) {
    const changeServer = create('button', 'options-button', 'Change server');
    changeServer.type = 'button';
    const onChangeServer = deps.onChangeServer;
    changeServer.addEventListener('click', () => onChangeServer());
    extraActions.appendChild(changeServer);
  }

  const settingsHeading = create('h3', 'options-heading', 'Settings');
  content.appendChild(settingsHeading);
  const settingsNote = create('div', 'options-note');
  content.appendChild(settingsNote);
  const issuesBox = create('div', 'options-issues hidden');
  content.appendChild(issuesBox);
  const form = create('div', 'options-form');
  content.appendChild(form);

  const saveBar = create('div', 'options-savebar');
  const saveButton = create('button', 'options-button options-primary', 'Save settings');
  saveButton.type = 'button';
  const revertButton = create('button', 'options-button', 'Discard changes');
  revertButton.type = 'button';
  const saveStatus = create('span', 'options-save-status');
  saveBar.appendChild(saveButton);
  saveBar.appendChild(revertButton);
  saveBar.appendChild(saveStatus);
  content.appendChild(saveBar);

  const logHeading = create('h3', 'options-heading', 'Recent warnings and errors');
  content.appendChild(logHeading);
  const logBox = create('div', 'options-log');
  const logEmpty = create('div', 'options-log-empty', 'Nothing has gone wrong yet.');
  logBox.appendChild(logEmpty);
  content.appendChild(logBox);

  // --- Steps ----------------------------------------------------------------

  const runAction = (action: () => Promise<void>, what: string): void => {
    void attemptAsync(action).then((outcome) => {
      if (outcome.ok) return;
      logger.error(`could not ${what}`, outcome.error);
      showMessage(`Could not ${what}: ${outcome.error.message}`, true);
    });
  };

  /** Applied at once rather than waiting a poll, so the toggle answers the press. */
  const setAuto = (which: 'autoQueue' | 'autoPlay', enabled: boolean): void => {
    pipeline =
      which === 'autoQueue' ? { ...pipeline, autoQueue: enabled } : { ...pipeline, autoPlay: enabled };
    renderSteps();
    runAction(
      () => (which === 'autoQueue' ? api.setAutoQueue(enabled) : api.setAutoPlay(enabled)),
      `turn ${which === 'autoQueue' ? 'auto queue' : 'auto play'} ${enabled ? 'on' : 'off'}`,
    );
  };

  const indexAction = (): StepAction => {
    const phase = pipeline.index;
    if (phase.status === 'running') {
      return { label: 'Indexing...', enabled: false, toggle: false, pressed: false, run: null };
    }
    const label = phase.status === 'done' ? 'Re-index' : 'Index';
    return {
      label,
      enabled: true,
      toggle: false,
      pressed: false,
      run: () => {
        pipeline = { ...pipeline, index: { ...pipeline.index, status: 'running', progress: 0 } };
        renderSteps();
        runAction(() => api.startIndex(), 'start indexing');
      },
    };
  };

  const queueAction = (): StepAction => {
    const phase = pipeline.queue;
    if (pipeline.index.status !== 'done') {
      return {
        label: pipeline.autoQueue ? 'Auto queue: on' : 'Auto queue: off',
        enabled: true,
        toggle: true,
        pressed: pipeline.autoQueue,
        run: () => setAuto('autoQueue', !pipeline.autoQueue),
      };
    }
    if (phase.status === 'running') {
      return { label: 'Preparing...', enabled: false, toggle: false, pressed: false, run: null };
    }
    if (phase.status === 'done') {
      return { label: 'Queue ready', enabled: false, toggle: false, pressed: false, run: null };
    }
    return {
      label: 'Queue',
      enabled: true,
      toggle: false,
      pressed: false,
      run: () => {
        pipeline = { ...pipeline, queue: { ...pipeline.queue, status: 'running', progress: 0 } };
        renderSteps();
        runAction(() => api.startQueue(), 'start the queue');
      },
    };
  };

  const playAction = (): StepAction => {
    if (mode === 'playback') {
      return {
        label: 'Back to video',
        enabled: true,
        toggle: false,
        pressed: false,
        run: () => deps.onClose(),
      };
    }
    if (pipeline.queue.status === 'done' || deps.playAlwaysReady) {
      return { label: 'Play', enabled: true, toggle: false, pressed: false, run: () => deps.onPlay() };
    }
    return {
      label: pipeline.autoPlay ? 'Auto play: on' : 'Auto play: off',
      enabled: true,
      toggle: true,
      pressed: pipeline.autoPlay,
      run: () => setAuto('autoPlay', !pipeline.autoPlay),
    };
  };

  const describePhase = (phase: PhaseState, idle: string): string => {
    if (phase.status === 'idle') return idle;
    if (phase.status === 'error' && phase.error !== null && phase.error !== phase.message) {
      return `${phase.message} (${phase.error})`;
    }
    return phase.message;
  };

  const actions: { index: StepAction; queue: StepAction; play: StepAction } = {
    index: indexAction(),
    queue: queueAction(),
    play: playAction(),
  };

  const renderStep = (view: StepView, action: StepAction, phase: PhaseState | null, text: string): void => {
    view.button.textContent = action.label;
    view.button.disabled = !action.enabled;
    setClass(view.button, 'toggle', action.toggle);
    setClass(view.button, 'pressed', action.pressed);
    view.button.setAttribute('aria-pressed', action.toggle ? String(action.pressed) : 'false');
    view.status.textContent = text;
    setClass(view.status, 'error', phase !== null && phase.status === 'error');
    const progress = phase === null ? 0 : phase.status === 'done' ? 1 : phase.progress;
    view.fill.style.width = formatPercent(progress);
  };

  const renderSteps = (): void => {
    actions.index = indexAction();
    actions.queue = queueAction();
    actions.play = playAction();

    renderStep(
      indexStep,
      actions.index,
      pipeline.index,
      describePhase(pipeline.index, 'Find the videos in the configured directories.'),
    );

    const queued =
      status !== null && pipeline.queue.status === 'done'
        ? `${status.preprocessedQueue.current} of ${status.preprocessedQueue.target} videos prepared`
        : null;
    renderStep(
      queueStep,
      actions.queue,
      pipeline.queue,
      queued ??
        describePhase(
          pipeline.queue,
          pipeline.index.status === 'done'
            ? 'Transcode the first videos.'
            : 'Runs once the index is done, or straight after it when auto queue is on.',
        ),
    );

    renderStep(
      playStep,
      actions.play,
      null,
      mode === 'playback'
        ? 'Close this panel and carry on watching.'
        : pipeline.queue.status === 'done' || deps.playAlwaysReady
          ? 'Start watching.'
          : 'Starts once the queue is ready, or straight after it when auto play is on.',
    );
    renderBanner();
  };

  indexStep.button.addEventListener('click', () => {
    const run = actions.index.run;
    if (run !== null) run();
  });
  queueStep.button.addEventListener('click', () => {
    const run = actions.queue.run;
    if (run !== null) run();
  });
  playStep.button.addEventListener('click', () => {
    const run = actions.play.run;
    if (run !== null) run();
  });

  const renderBanner = (): void => {
    const update = pipeline.update;
    if (update === null) {
      setClass(banner, HIDDEN_CLASS, true);
      return;
    }
    // The video count only means something once there is a queue to change.
    const delay =
      pipeline.queue.status === 'done'
        ? update.reindex
          ? " You won't see a difference for 3 to 10 videos."
          : " You won't see a difference for 2 to 3 videos."
        : '';
    banner.textContent = `${update.message}.${delay}`;
    setClass(banner, HIDDEN_CLASS, false);
  };

  const showMessage = (text: string, isError: boolean): void => {
    message.textContent = text;
    setClass(message, 'error', isError);
    setClass(message, HIDDEN_CLASS, text === '');
  };

  // --- Settings form --------------------------------------------------------

  const isDirty = (): boolean => Object.keys(changes).length > 0;
  const hasInvalid = (): boolean => Object.keys(invalid).length > 0;

  const renderSaveBar = (): void => {
    const count = Object.keys(changes).length;
    saveButton.disabled = saving || count === 0 || hasInvalid();
    revertButton.disabled = saving || (count === 0 && !hasInvalid());
    if (saving) saveStatus.textContent = 'Saving...';
    else if (hasInvalid()) saveStatus.textContent = 'Fix the highlighted values to save.';
    else if (count > 0) saveStatus.textContent = `${count} unsaved change${count === 1 ? '' : 's'}`;
  };

  /** Records a field's new value, or forgets the change when it is back to the original. */
  const record = (path: string, value: unknown, original: unknown): void => {
    delete invalid[path];
    if (sameValue(value, original)) delete changes[path];
    else changes[path] = value;
    const row = rows[path];
    if (row !== undefined) {
      setClass(row, 'invalid', false);
      setClass(row, 'changed', path in changes);
    }
    renderSaveBar();
  };

  const markInvalid = (path: string, reason: string): void => {
    invalid[path] = reason;
    delete changes[path];
    const row = rows[path];
    if (row !== undefined) {
      setClass(row, 'invalid', true);
      const note = row.querySelector('.options-field-error');
      if (note !== null) note.textContent = reason;
    }
    renderSaveBar();
  };

  const makeRow = (path: string, label: string, parent: HTMLElement): HTMLElement => {
    const row = create('div', 'options-field');
    const labelElement = create('label', 'options-label', label);
    row.appendChild(labelElement);
    if (requiresRestart(path)) {
      labelElement.appendChild(create('span', 'options-restart', 'restart'));
    }
    parent.appendChild(row);
    rows[path] = row;
    return row;
  };

  const appendHint = (row: HTMLElement, path: string): void => {
    const hint = HINTS[path];
    if (hint !== undefined) row.appendChild(create('div', 'options-hint', hint));
    row.appendChild(create('div', 'options-field-error'));
  };

  const renderBoolean = (path: string, label: string, value: boolean, parent: HTMLElement): void => {
    const row = makeRow(path, label, parent);
    const input = create('input', 'options-checkbox');
    input.type = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => record(path, input.checked, value));
    row.insertBefore(input, row.firstChild);
    setClass(row, 'boolean', true);
    appendHint(row, path);
  };

  const renderNumber = (path: string, label: string, value: number, parent: HTMLElement): void => {
    const row = makeRow(path, label, parent);
    const input = create('input', 'options-input');
    input.type = 'number';
    input.step = 'any';
    input.value = String(value);
    input.addEventListener('input', () => {
      const text = input.value.trim();
      const parsed = Number(text);
      if (text === '' || !isFinite(parsed)) {
        markInvalid(path, 'Enter a number');
        return;
      }
      record(path, parsed, value);
    });
    row.appendChild(input);
    appendHint(row, path);
  };

  const renderChoice = (
    path: string,
    label: string,
    value: string,
    choices: readonly string[],
    parent: HTMLElement,
  ): void => {
    const row = makeRow(path, label, parent);
    const select = create('select', 'options-input');
    for (let index = 0; index < choices.length; index += 1) {
      const choice = choices[index] as string;
      const option = create('option', undefined, choice);
      option.value = choice;
      if (choice === value) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => record(path, select.value, value));
    row.appendChild(select);
    appendHint(row, path);
  };

  const renderText = (path: string, label: string, value: string, parent: HTMLElement): void => {
    const row = makeRow(path, label, parent);
    const input = create('input', 'options-input');
    input.type = 'text';
    input.value = value;
    input.addEventListener('input', () => record(path, input.value, value));
    row.appendChild(input);
    appendHint(row, path);
  };

  const renderList = (path: string, label: string, value: readonly string[], parent: HTMLElement): void => {
    const row = makeRow(path, label, parent);
    const area = create('textarea', 'options-textarea');
    area.rows = Math.max(2, Math.min(8, value.length + 1));
    area.value = value.join('\n');
    area.addEventListener('input', () => {
      const lines = area.value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      record(path, lines, value);
    });
    row.appendChild(area);
    row.appendChild(create('div', 'options-hint', 'One per line.'));
    appendHint(row, path);
  };

  const renderDirectories = (value: readonly DirectoryConfig[], parent: HTMLElement): void => {
    const path = 'directories';
    const row = makeRow(path, 'Directories and their bias', parent);
    setClass(row, 'wide', true);
    const list = create('div', 'options-directories');
    row.appendChild(list);

    const entries: { path: HTMLInputElement; bias: HTMLInputElement; line: HTMLElement }[] = [];

    const collect = (): void => {
      const result: DirectoryConfig[] = [];
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry === undefined) continue;
        const directory = entry.path.value.trim();
        if (directory === '') continue;
        const text = entry.bias.value.trim();
        const bias = text === '' ? 1 : Number(text);
        if (!isFinite(bias) || bias < 0) {
          markInvalid(path, `The bias for ${directory} must be a number of 0 or more`);
          return;
        }
        result.push({ directory, bias });
      }
      record(path, result, value);
    };

    const addLine = (entry: DirectoryConfig | null): void => {
      const line = create('div', 'options-directory');
      const pathInput = create('input', 'options-input options-directory-path');
      pathInput.type = 'text';
      pathInput.placeholder = 'C:\\Videos or /mnt/videos';
      pathInput.value = entry === null ? '' : entry.directory;
      const biasInput = create('input', 'options-input options-directory-bias');
      biasInput.type = 'number';
      biasInput.step = 'any';
      biasInput.min = '0';
      biasInput.value = entry === null ? '1' : String(entry.bias);
      biasInput.title = 'Bias';
      const remove = create('button', 'options-button options-small', 'Remove');
      remove.type = 'button';
      const view = { path: pathInput, bias: biasInput, line };
      remove.addEventListener('click', () => {
        const at = entries.indexOf(view);
        if (at !== -1) entries.splice(at, 1);
        if (line.parentNode !== null) line.parentNode.removeChild(line);
        collect();
      });
      pathInput.addEventListener('input', collect);
      biasInput.addEventListener('input', collect);
      line.appendChild(pathInput);
      line.appendChild(create('span', 'options-directory-label', 'bias'));
      line.appendChild(biasInput);
      line.appendChild(remove);
      list.appendChild(line);
      entries.push(view);
    };

    for (let index = 0; index < value.length; index += 1) {
      addLine(value[index] ?? null);
    }
    const add = create('button', 'options-button options-small', 'Add directory');
    add.type = 'button';
    add.addEventListener('click', () => {
      addLine(null);
      const last = entries[entries.length - 1];
      if (last !== undefined) last.path.focus();
    });
    row.appendChild(add);
    appendHint(row, path);
  };

  const renderSeasonal = (value: unknown, parent: HTMLElement): void => {
    const path = 'seasonalDirectories';
    const row = makeRow(path, 'Seasonal entries (JSON)', parent);
    setClass(row, 'wide', true);
    const area = create('textarea', 'options-textarea options-code');
    const text = JSON.stringify(value === undefined ? [] : value, null, 2);
    area.value = text;
    area.rows = Math.max(4, Math.min(20, text.split('\n').length + 1));
    area.addEventListener('input', () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(area.value) as unknown;
      } catch (thrown) {
        markInvalid(path, `Not valid JSON: ${(thrown as Error).message}`);
        return;
      }
      if (!Array.isArray(parsed)) {
        markInvalid(path, 'Must be a JSON list: [ ... ]');
        return;
      }
      record(path, parsed, value);
    });
    row.appendChild(area);
    appendHint(row, path);
  };

  /** Draws every leaf under `shape`, recursing into nested sections. */
  const renderFields = (
    shape: Readonly<Record<string, unknown>>,
    values: unknown,
    prefix: string,
    parent: HTMLElement,
  ): void => {
    const keys = Object.keys(shape);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index] as string;
      const path = joinPath(prefix, key);
      if (HIDDEN_PATHS.indexOf(path) !== -1) continue;
      const fieldShape = shape[key];
      const value = readPath(values, [key]);

      if (isPlainObject(fieldShape)) {
        const group = create('div', 'options-group');
        group.appendChild(create('div', 'options-group-title', humanize(key)));
        parent.appendChild(group);
        renderFields(fieldShape, value, path, group);
        continue;
      }

      const label = humanize(key);
      const choices = choicesFor(path);
      if (typeof fieldShape === 'boolean') {
        renderBoolean(path, label, value === true, parent);
      } else if (typeof fieldShape === 'number') {
        renderNumber(path, label, typeof value === 'number' ? value : fieldShape, parent);
      } else if (typeof fieldShape === 'string' && choices !== null) {
        renderChoice(path, label, typeof value === 'string' ? value : fieldShape, choices, parent);
      } else if (typeof fieldShape === 'string') {
        renderText(path, label, typeof value === 'string' ? value : fieldShape, parent);
      } else if (Array.isArray(fieldShape)) {
        const list = Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : [];
        renderList(path, label, list, parent);
      }
    }
  };

  const renderSection = (key: string, heading: string, editable: EditableConfig): void => {
    const section = create('details', 'options-section');
    if (OPEN_SECTIONS.indexOf(key) !== -1) section.open = true;
    const summary = create('summary', 'options-section-title', heading);
    section.appendChild(summary);
    const body = create('div', 'options-section-body');
    section.appendChild(body);
    form.appendChild(section);

    if (key === 'directories') {
      renderDirectories(editable.config.directories, body);
      return;
    }
    if (key === 'seasonalDirectories') {
      renderSeasonal(editable.seasonalDirectories, body);
      return;
    }
    const shape = (DEFAULT_CONFIG as unknown as Readonly<Record<string, unknown>>)[key];
    const values = (editable.config as unknown as Readonly<Record<string, unknown>>)[key];
    if (isPlainObject(shape)) {
      renderFields(shape, values, key, body);
      if (HINTS[key] !== undefined) body.appendChild(create('div', 'options-hint', HINTS[key]));
    }
  };

  const renderIssues = (issues: readonly ConfigIssue[], heading: string): void => {
    issuesBox.innerHTML = '';
    if (issues.length === 0) {
      setClass(issuesBox, HIDDEN_CLASS, true);
      return;
    }
    issuesBox.appendChild(create('div', 'options-issues-title', heading));
    for (let index = 0; index < issues.length; index += 1) {
      const issue = issues[index];
      if (issue === undefined) continue;
      issuesBox.appendChild(create('div', `options-issue ${issue.severity}`, `${issue.path}: ${issue.message}`));
    }
    setClass(issuesBox, HIDDEN_CLASS, false);
  };

  const renderForm = (editable: EditableConfig): void => {
    form.innerHTML = '';
    changes = {};
    invalid = {};
    rows = {};
    settingsNote.textContent =
      `Saved to ${editable.configFile}. Fields marked "restart" take effect the next time ` +
      'VideoJuke starts; everything else applies straight away.';

    const drawn: string[] = [];
    for (let index = 0; index < SECTION_ORDER.length; index += 1) {
      const entry = SECTION_ORDER[index];
      if (entry === undefined) continue;
      renderSection(entry[0], entry[1], editable);
      drawn.push(entry[0]);
    }
    const remaining = Object.keys(DEFAULT_CONFIG).filter((key) => drawn.indexOf(key) === -1);
    for (let index = 0; index < remaining.length; index += 1) {
      const key = remaining[index] as string;
      renderSection(key, humanize(key), editable);
    }

    renderIssues(editable.issues, `Problems in ${editable.configFile}`);
    saveStatus.textContent = '';
    renderSaveBar();
  };

  const reload = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    const fetched = await attemptAsync(() => api.getEditableConfig());
    loading = false;
    if (disposed) return;
    if (!fetched.ok) {
      logger.error('could not read the settings', fetched.error);
      settingsNote.textContent = `Could not read the settings: ${fetched.error.message}`;
      return;
    }
    loaded = fetched.value;
    renderForm(fetched.value);
  };

  /** A refused save names the fields; each one is marked where it is drawn. */
  const markRejected = (issues: readonly ConfigIssue[]): void => {
    const paths = Object.keys(rows);
    for (let index = 0; index < issues.length; index += 1) {
      const issue = issues[index];
      if (issue === undefined) continue;
      // The longest field path the issue sits under: `directories[2]` belongs
      // to `directories`, `audio.normalization.targetLufs` to itself.
      let best: string | null = null;
      for (let at = 0; at < paths.length; at += 1) {
        const candidate = paths[at] as string;
        const within =
          issue.path === candidate ||
          issue.path.indexOf(`${candidate}.`) === 0 ||
          issue.path.indexOf(`${candidate}[`) === 0;
        if (within && (best === null || candidate.length > best.length)) best = candidate;
      }
      if (best === null) continue;
      const row = rows[best];
      if (row === undefined) continue;
      setClass(row, 'invalid', true);
      const note = row.querySelector('.options-field-error');
      if (note !== null) note.textContent = issue.message;
    }
  };

  const save = async (): Promise<void> => {
    if (saving || !isDirty() || hasInvalid()) return;
    saving = true;
    renderSaveBar();
    const patch = toPatch(changes);
    const result = await attemptAsync(() => api.saveConfig(patch));
    saving = false;
    if (disposed) return;

    if (!result.ok) {
      logger.error('could not save the settings', result.error);
      renderSaveBar();
      saveStatus.textContent = `Could not save: ${result.error.message}`;
      return;
    }
    const outcome = result.value;
    if (!outcome.ok) {
      renderSaveBar();
      saveStatus.textContent = outcome.message;
      markRejected(outcome.issues);
      renderIssues(outcome.issues, 'Not saved:');
      return;
    }

    logger.info(`settings saved (${outcome.impact})`);
    deps.onSaved();
    await reload();
    saveStatus.textContent =
      outcome.restartRequired.length > 0
        ? `Saved. Restart VideoJuke for ${outcome.restartRequired.join(', ')} to take effect.`
        : 'Saved.';
  };

  saveButton.addEventListener('click', () => {
    void save();
  });
  revertButton.addEventListener('click', () => {
    if (loaded !== null) renderForm(loaded);
  });

  // --- Log ------------------------------------------------------------------

  const renderLog = (records: readonly LogRecord[]): void => {
    const newest = records.length === 0 ? 0 : (records[records.length - 1] as LogRecord).sequence;
    // Numbered from one again: the server restarted, so start the list afresh.
    if (newest < lastLogSequence) {
      logBox.innerHTML = '';
      lastLogSequence = 0;
    }
    const nearBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40;
    let added = 0;
    for (let index = 0; index < records.length; index += 1) {
      const entry = records[index];
      if (entry === undefined || entry.sequence <= lastLogSequence) continue;
      const line = create('div', `options-log-line ${entry.level}`);
      line.textContent = `${clockTime(entry.timestamp)}  ${entry.level.toUpperCase()}  ${entry.scope}: ${entry.message}`;
      logBox.appendChild(line);
      lastLogSequence = entry.sequence;
      added += 1;
    }
    if (added === 0) return;
    if (logEmpty.parentNode !== null) logEmpty.parentNode.removeChild(logEmpty);
    while (logBox.childNodes.length > LOG_ROW_LIMIT && logBox.firstChild !== null) {
      logBox.removeChild(logBox.firstChild);
    }
    if (nearBottom) logBox.scrollTop = logBox.scrollHeight;
  };

  const pollLog = async (): Promise<void> => {
    const fetched = await attemptAsync(() => api.getRecentLog());
    if (disposed || !fetched.ok) return;
    renderLog(fetched.value);
  };

  const startLogPolling = (): void => {
    if (logTimer !== null) return;
    void pollLog();
    logTimer = setInterval(() => {
      void pollLog();
    }, LOG_POLL_INTERVAL_MS);
  };

  const stopLogPolling = (): void => {
    if (logTimer === null) return;
    clearInterval(logTimer);
    logTimer = null;
  };

  // --- Focus ----------------------------------------------------------------

  /** Every control a viewer can currently reach, in reading order. */
  const focusables = (): HTMLElement[] => {
    const found = container.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, summary',
    );
    const result: HTMLElement[] = [];
    for (let index = 0; index < found.length; index += 1) {
      const element = found[index];
      if (element === undefined) continue;
      if ((element as HTMLButtonElement).disabled === true) continue;
      // Not drawn: inside a closed section, or hidden.
      if (element.offsetParent === null) continue;
      result.push(element);
    }
    return result;
  };

  const moveFocus = (step: number): void => {
    const list = focusables();
    if (list.length === 0) return;
    const active = root.activeElement as HTMLElement | null;
    const at = active === null ? -1 : list.indexOf(active);
    const next = at === -1 ? (step > 0 ? 0 : list.length - 1) : at + step;
    const target = list[Math.max(0, Math.min(list.length - 1, next))];
    if (target === undefined) return;
    target.focus();
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView(false);
  };

  /**
   * The steps are at the top, where `show` leaves the panel, so there is
   * nothing to scroll to - and a page that is laid out before it has a size
   * (a background tab) scrolled half the form past the steps to "reveal" one.
   * An engine too old for the option ignores it, which costs nothing here.
   */
  const focusWithoutScrolling = (element: HTMLElement): void => {
    element.focus({ preventScroll: true });
  };

  /**
   * The step a viewer most likely wants next, so OK on a remote does it: the
   * furthest one along that is ready to run. An auto toggle is never the
   * likely choice, so Play only wins once there is something to play.
   */
  const focusLikelyStep = (): void => {
    const ordered = [playStep.button, queueStep.button, indexStep.button];
    for (let index = 0; index < ordered.length; index += 1) {
      const button = ordered[index] as HTMLButtonElement;
      if (!button.disabled && !button.classList.contains('toggle')) {
        focusWithoutScrolling(button);
        return;
      }
    }
    focusWithoutScrolling(playStep.button);
  };

  const isTextEntry = isEditableTarget;

  /**
   * Captured, so it runs before the player's own key handling: the direction
   * pad that skips videos is also the only way to move between fields on a TV.
   * Whatever this answers is marked with `preventDefault`, which the keyboard
   * and remote handlers both honour.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!visible) return;
    const code = event.keyCode;
    const target = event.target;

    if (code === KEY_ESCAPE && isTextEntry(target)) {
      // Leaving the field, not the panel: Escape inside a field used to mean
      // "close the window" one keystroke away from losing an edit.
      (target as HTMLElement).blur();
      event.preventDefault();
      return;
    }

    if (code === KEY_ENTER && target !== null && (target as HTMLInputElement).type === 'checkbox') {
      (target as HTMLInputElement).click();
      event.preventDefault();
      return;
    }

    const vertical = code === KEY_UP || code === KEY_DOWN;
    const horizontal = code === KEY_LEFT || code === KEY_RIGHT;
    if (!vertical && !horizontal) return;

    if (deps.arrowNavigation) {
      // Left and right stay with a text field, which needs them for its cursor.
      if (horizontal && isTextEntry(target)) return;
      moveFocus(code === KEY_DOWN || code === KEY_RIGHT ? 1 : -1);
      event.preventDefault();
      return;
    }

    // With a keyboard, arrows step between buttons and checkboxes only; in a
    // field they belong to the field, and with nothing focused they scroll.
    if (!vertical || isTextEntry(target)) return;
    if (target === null || !container.contains(target as Node) || target === container) return;
    moveFocus(code === KEY_DOWN ? 1 : -1);
    event.preventDefault();
  };

  root.addEventListener('keydown', onKeyDown, true);

  // --- Public ---------------------------------------------------------------

  const show = (): void => {
    if (visible) return;
    visible = true;
    setClass(container, HIDDEN_CLASS, false);
    container.scrollTop = 0;
    renderSteps();
    startLogPolling();
    // Every time it opens, unless the viewer is mid-edit: the settings may have
    // been changed by hand or from another screen since they were drawn.
    if (!isDirty() && !hasInvalid()) void reload();
    focusLikelyStep();
  };

  const hide = (): void => {
    if (!visible) return;
    visible = false;
    setClass(container, HIDDEN_CLASS, true);
    stopLogPolling();
    const active = root.activeElement as HTMLElement | null;
    if (active !== null && container.contains(active)) active.blur();
  };

  renderSteps();

  return {
    show,
    hide,
    isVisible: () => visible,

    setMode: (next) => {
      mode = next;
      title.textContent = next === 'playback' ? 'Options' : 'VideoJuke';
      renderSteps();
    },

    applyPipeline: (state) => {
      pipeline = state;
      renderSteps();
    },

    applyStatus: (next) => {
      status = next;
      pipeline = next.pipeline;
      renderSteps();
    },

    notifyRevision: (revision) => {
      if (!visible || loaded === null || loaded.revision === revision) return;
      if (isDirty() || hasInvalid() || saving) return;
      void reload();
    },

    showMessage,

    cleanup: () => {
      if (disposed) return;
      disposed = true;
      stopLogPolling();
      root.removeEventListener('keydown', onKeyDown, true);
      container.innerHTML = '';
      setClass(banner, HIDDEN_CLASS, true);
    },
  };
};
