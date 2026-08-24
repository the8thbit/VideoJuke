/**
 * The one vocabulary every input source speaks.
 *
 * A keyboard and a TV remote arrive as completely different events, and the
 * legacy clients answered each of them separately: `controls.js` implemented
 * eighteen handlers against the player and `remoteControl.js` implemented its
 * own copy of nine of them. That is why the remote stepped the speed by a
 * hardcoded 0.25 while the keyboard used `playback.speedIncrement`, and why
 * only one of the two knew about the debug panel. Both now translate their raw
 * input into these commands, and the application answers each one exactly once.
 */
export type PlayerCommand =
  | 'next'
  | 'previous'
  | 'play-pause'
  | 'restart'
  | 'toggle-loop'
  | 'toggle-mute'
  | 'toggle-crossfade'
  | 'toggle-blur'
  | 'speed-up'
  | 'speed-down'
  | 'reset-speed'
  | 'skip-forward'
  | 'skip-backward'
  | 'show-info'
  | 'show-title'
  | 'toggle-archive'
  | 'toggle-debug'
  | 'toggle-controls'
  | 'stop'
  | 'show-settings'
  | 'exit';

/** Accepts a command from any input source. */
export type CommandDispatcher = (command: PlayerCommand) => void;
