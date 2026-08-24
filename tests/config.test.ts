import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_CONFIG } from '../src/shared/config/defaults';
import { computeConfigHash, indexRelevantConfigFingerprint } from '../src/shared/config/hash';
import { normalizeConfig } from '../src/shared/config/normalize';

// Tests compile to .tsbuild/test/tests, three levels below the repository root.
const REPO_ROOT = join(__dirname, '..', '..', '..');

const readDefaultConfigFile = (): unknown =>
  JSON.parse(readFileSync(join(REPO_ROOT, 'config.default.json'), 'utf8')) as unknown;

const issuesAt = (issues: readonly { readonly path: string }[], path: string): number =>
  issues.filter((issue) => issue.path === path).length;

describe('normalizeConfig', () => {
  it('clamps loudnorm parameters to the range ffmpeg accepts', () => {
    // Outside these, ffmpeg refuses to build the filter graph, which fails every
    // transcode - and the compatibility retry re-emits the same value and fails
    // again, so the app indexes a whole library and preprocesses none of it.
    const { config, issues } = normalizeConfig({
      directories: ['/videos'],
      audio: { normalization: { targetLUFS: 10, truePeak: 6, LRA: 500 } },
    });

    assert.equal(config.audio.normalization.targetLufs, -5);
    assert.equal(config.audio.normalization.truePeak, 0);
    assert.equal(config.audio.normalization.loudnessRange, 50);
    assert.equal(issuesAt(issues, 'audio.normalization.targetLUFS'), 1);
    assert.equal(issuesAt(issues, 'audio.normalization.truePeak'), 1);
    assert.equal(issuesAt(issues, 'audio.normalization.LRA'), 1);
  });

  it('lets normalization.strength actually choose the loudness target', () => {
    // The shipped defaults used to write the medium preset's values inline, and
    // an explicit value beats a preset, so `strength` could never change
    // anything for anyone who started from the template.
    const raw = readDefaultConfigFile() as Record<string, Record<string, unknown>>;
    const audio = raw['audio'] as Record<string, Record<string, unknown>>;
    const normalization = audio['normalization'] as Record<string, unknown>;
    for (const inline of ['targetLUFS', 'targetLufs', 'truePeak', 'LRA', 'loudnessRange']) {
      assert.equal(inline in normalization, false, `config.default.json still pins ${inline}`);
    }

    const { config } = normalizeConfig({
      ...raw,
      directories: ['/videos'],
      audio: { ...audio, normalization: { ...normalization, strength: 'broadcast' } },
    });
    assert.deepEqual(
      {
        targetLufs: config.audio.normalization.targetLufs,
        truePeak: config.audio.normalization.truePeak,
        loudnessRange: config.audio.normalization.loudnessRange,
      },
      { targetLufs: -23, truePeak: -1, loudnessRange: 7 },
    );
  });

  it('treats an absent user config as the defaults', () => {
    const { config, issues } = normalizeConfig(undefined);
    assert.deepEqual(config, DEFAULT_CONFIG);
    // Only the empty-directories error, which is genuinely true of the defaults.
    assert.deepEqual(
      issues.map((issue) => issue.path),
      ['directories'],
    );
  });

  it('keeps config.default.json and DEFAULT_CONFIG in agreement', () => {
    // The JSON file is the user-facing template; the TypeScript value is the
    // single source of truth. This test is what stops the two from drifting.
    const { config } = normalizeConfig(readDefaultConfigFile());
    assert.deepEqual(config, DEFAULT_CONFIG);
  });

  it('overlays only the fields the user set', () => {
    const { config } = normalizeConfig({
      directories: ['/videos'],
      video: { preprocessedQueueSize: 7 },
    });

    assert.deepEqual(config.directories, ['/videos']);
    assert.equal(config.video.preprocessedQueueSize, 7);
    assert.equal(config.video.playbackQueueSize, DEFAULT_CONFIG.video.playbackQueueSize);
    assert.deepEqual(config.audio, DEFAULT_CONFIG.audio);
  });

  it('accepts the legacy spellings that exist in real config files', () => {
    const { config } = normalizeConfig({
      directories: ['/videos'],
      audio: {
        enabled51Processing: false,
        forceOutputChannels: 2,
        normalization: { targetLUFS: -20, LRA: 9, truePeak: -2 },
        compatibility: { forceAAC: false },
      },
    });

    assert.equal(config.audio.surroundProcessingEnabled, false);
    assert.equal(config.audio.outputChannels, 2);
    assert.equal(config.audio.normalization.targetLufs, -20);
    assert.equal(config.audio.normalization.loudnessRange, 9);
    assert.equal(config.audio.normalization.truePeak, -2);
    assert.equal(config.audio.compatibility.forceAac, false);
  });

  it('ignores keys that no longer mean anything without complaining', () => {
    const { issues } = normalizeConfig({
      directories: ['/videos'],
      video: { restartDelay: 2000, historySize: 50 },
      audio: { outputChannelLayout: '5.1', compatibility: { fallbackToStereo: true } },
      network: { client: { serverUrl: 'http://localhost:3123' } },
      system: { maxLogFiles: 5 },
    });

    assert.deepEqual(issues, []);
  });

  it('clamps out-of-range numbers and reports why', () => {
    const { config, issues } = normalizeConfig({
      directories: ['/videos'],
      network: { server: { port: 99999 } },
      performance: { cpuLimiting: { maxThreads: 64, threadQueueSize: 4, processingDelay: -5 } },
    });

    assert.equal(config.network.server.port, 65535);
    assert.equal(config.performance.cpuLimiting.maxThreads, 8);
    assert.equal(config.performance.cpuLimiting.threadQueueSize, 128);
    assert.equal(config.performance.cpuLimiting.processingDelay, 0);
    assert.equal(issuesAt(issues, 'network.server.port'), 1);
    assert.equal(issuesAt(issues, 'performance.cpuLimiting.maxThreads'), 1);
  });

  it('falls back when an enum is misspelled', () => {
    const { config, issues } = normalizeConfig({
      directories: ['/videos'],
      performance: { mode: 'turbo' },
      system: { logLevel: 'verbose' },
    });

    assert.equal(config.performance.mode, DEFAULT_CONFIG.performance.mode);
    assert.equal(config.system.logLevel, DEFAULT_CONFIG.system.logLevel);
    assert.equal(issuesAt(issues, 'performance.mode'), 1);
    assert.equal(issuesAt(issues, 'system.logLevel'), 1);
  });

  it('reports an error when no directories are configured', () => {
    const { issues } = normalizeConfig({ directories: [] });
    const directoryIssues = issues.filter((issue) => issue.path === 'directories');
    assert.equal(directoryIssues.length, 1);
    assert.equal(directoryIssues[0]?.severity, 'error');
  });

  it('normalises supported extensions to lower case with a leading dot', () => {
    const { config } = normalizeConfig({
      directories: ['/videos'],
      files: { supportedVideoExtensions: ['MP4', '.MkV', 'webm'] },
    });

    assert.deepEqual(config.files.supportedVideoExtensions, ['.mp4', '.mkv', '.webm']);
  });

  describe('seasonal directories', () => {
    it('normalises scalar and array time conditions alike', () => {
      const { config } = normalizeConfig({
        directories: ['/videos'],
        seasonalDirectories: [
          {
            directory: '/seasonal/pride',
            likelihood: 0.15,
            conditions: { month: 6, dayOfMonth: [1, 2] },
            _comment: 'Pride month',
          },
        ],
      });

      const entry = config.seasonalDirectories[0];
      assert.equal(entry?.directory, '/seasonal/pride');
      assert.equal(entry?.likelihood, 0.15);
      assert.equal(entry?.comment, 'Pride month');
      assert.deepEqual(entry?.conditions.months, [6]);
      assert.deepEqual(entry?.conditions.daysOfMonth, [1, 2]);
      assert.equal(entry?.conditions.hours, null);
    });

    it('clamps likelihood into 0..1', () => {
      const { config } = normalizeConfig({
        directories: ['/videos'],
        seasonalDirectories: [{ directory: '/a', likelihood: 4, conditions: { month: 1 } }],
      });

      assert.equal(config.seasonalDirectories[0]?.likelihood, 1);
    });

    it('drops entries without a usable directory or conditions object', () => {
      const { config, issues } = normalizeConfig({
        directories: ['/videos'],
        seasonalDirectories: [
          { likelihood: 0.5, conditions: { month: 1 } },
          { directory: '/b', likelihood: 0.5 },
          { directory: '/c', likelihood: 0.5, conditions: 'weekends' },
          { directory: '/keep', likelihood: 0.5, conditions: { month: 12 } },
        ],
      });

      assert.deepEqual(
        config.seasonalDirectories.map((entry) => entry.directory),
        ['/keep'],
      );
      assert.equal(issues.filter((issue) => issue.path.startsWith('seasonalDirectories')).length, 3);
    });
  });
});

describe('config fingerprint', () => {
  const withDirectories = (directories: readonly string[]) =>
    normalizeConfig({ directories }).config;

  it('ignores settings that cannot change what the index contains', () => {
    const base = withDirectories(['/videos']);
    const tweaked = normalizeConfig({
      directories: ['/videos'],
      ui: { infoDuration: 9999 },
      timeouts: { errorRecoveryDelay: 4321 },
      audio: { normalization: { strength: 'strong' } },
      // How often the index is rebuilt says nothing about what a rebuild finds.
      // It used to be part of the fingerprint, so raising the re-scan period
      // marked the index stale, which cleared the queue - deleting every
      // transcode the user had waited for to answer a change that could not
      // have altered a single entry.
      video: { updateInterval: 7654321 },
    }).config;

    assert.equal(indexRelevantConfigFingerprint(base), indexRelevantConfigFingerprint(tweaked));
  });

  it('changes when the scanned directories change', () => {
    assert.notEqual(
      indexRelevantConfigFingerprint(withDirectories(['/a'])),
      indexRelevantConfigFingerprint(withDirectories(['/a', '/b'])),
    );
  });

  it('is insensitive to key order in the source object', () => {
    const first = normalizeConfig({ directories: ['/a'], video: { updateInterval: 1000 } }).config;
    const second = normalizeConfig({ video: { updateInterval: 1000 }, directories: ['/a'] }).config;

    const digest = (input: string): string => `len:${input.length}`;
    assert.equal(computeConfigHash(first, digest), computeConfigHash(second, digest));
  });
});
