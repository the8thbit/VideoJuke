import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { animate, cancelAnimation } from '../src/client/core/dom/animation';

type FrameCallback = (time: number) => void;

const globals = globalThis as { requestAnimationFrame?: (callback: FrameCallback) => number };

/** Installs an animation clock that never calls back, as a hidden tab does. */
const installStalledFrameClock = (): void => {
  globals.requestAnimationFrame = () => 0;
};

/** Installs one that runs on a timer, standing in for a visible tab. */
const installRunningFrameClock = (): void => {
  globals.requestAnimationFrame = (callback) => {
    setTimeout(() => callback(Date.now()), 8);
    return 0;
  };
};

afterEach(() => {
  delete globals.requestAnimationFrame;
});

describe('animate', () => {
  it('runs to completion on a live animation clock', async () => {
    installRunningFrameClock();

    const frames: number[] = [];
    const handle = animate({ durationMs: 60, onFrame: (progress) => frames.push(progress) });

    assert.equal(await handle.finished, true);
    assert.equal(frames.at(-1), 1);
    assert.ok(frames.length > 1, 'expected several intermediate frames');
  });

  /**
   * The regression this file exists for. Browsers stop firing
   * requestAnimationFrame while a tab is hidden, and the player awaits the
   * crossfade before advancing, so an rAF-only tween meant playback froze the
   * first time a fade started in a backgrounded tab.
   */
  it('still finishes when the animation clock never fires', async () => {
    installStalledFrameClock();

    const frames: number[] = [];
    const handle = animate({ durationMs: 40, onFrame: (progress) => frames.push(progress) });

    assert.equal(await handle.finished, true);
    assert.equal(frames.at(-1), 1, 'the final frame must still be applied');
  });

  it('reports cancellation rather than completion', async () => {
    installRunningFrameClock();

    const handle = animate({ durationMs: 5000, onFrame: () => undefined });
    handle.cancel();

    assert.equal(await handle.finished, false);
  });

  it('ignores a cancel that arrives after it finished', async () => {
    installRunningFrameClock();

    const handle = animate({ durationMs: 20, onFrame: () => undefined });
    assert.equal(await handle.finished, true);

    handle.cancel();
    assert.equal(await handle.finished, true);
  });

  it('settles immediately for a zero-length tween', async () => {
    installRunningFrameClock();

    const frames: number[] = [];
    const handle = animate({ durationMs: 0, onFrame: (progress) => frames.push(progress) });

    assert.equal(await handle.finished, true);
    assert.deepEqual(frames, [1]);
  });

  it('applies the easing curve rather than raw progress', async () => {
    installRunningFrameClock();

    const frames: number[] = [];
    const handle = animate({
      durationMs: 40,
      easing: (progress) => progress * 0.5,
      onFrame: (progress) => frames.push(progress),
    });

    assert.equal(await handle.finished, true);
    assert.equal(frames.at(-1), 0.5);
  });
});

describe('cancelAnimation', () => {
  it('cancels a handle and yields null so callers can reassign', async () => {
    installRunningFrameClock();

    const handle = animate({ durationMs: 5000, onFrame: () => undefined });
    assert.equal(cancelAnimation(handle), null);
    assert.equal(await handle.finished, false);
    assert.equal(cancelAnimation(null), null);
  });
});
