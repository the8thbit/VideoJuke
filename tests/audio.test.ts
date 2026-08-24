import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/shared/config/normalize';
import type { AppConfig } from '../src/shared/types/config';
import type { AudioStreamInfo } from '../src/shared/types/video';
import {
  buildAudioFilterChain,
  buildLoudnormFilter,
  buildStereoFilterChain,
  resolveLoudnessTarget,
} from '../src/shared/video/audioFilters';
import {
  classifyAudioProfile,
  deriveChannelLayout,
  isSurroundLayout,
  requiresUpmixing,
} from '../src/shared/video/audioProfile';
import {
  MP4_OUTPUT_OPTIONS,
  buildPerformanceOutputOptions,
  planTranscode,
  resolvePerformanceSettings,
  selectAudioEncoding,
} from '../src/shared/video/encoding';

const configWith = (overrides: Record<string, unknown> = {}): AppConfig =>
  normalizeConfig({ directories: ['/videos'], ...overrides }).config;

const BASE = configWith();

const MEDIUM_LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';

const audio = (channels: number, channelLayout = deriveChannelLayout(channels)): AudioStreamInfo => ({
  channels,
  channelLayout,
  codec: 'aac',
  sampleRate: 48000,
  bitrate: 128000,
  profile: classifyAudioProfile(channels, channelLayout),
});

describe('audio profile', () => {
  it('derives a layout when ffprobe omits one', () => {
    assert.equal(deriveChannelLayout(1), 'mono');
    assert.equal(deriveChannelLayout(2), 'stereo');
    assert.equal(deriveChannelLayout(6), '5.1');
    assert.equal(deriveChannelLayout(8), '7.1');
    assert.equal(deriveChannelLayout(9), '9ch');
  });

  it('recognises both spellings of a 5.1 layout', () => {
    assert.equal(isSurroundLayout('5.1'), true);
    assert.equal(isSurroundLayout('5.1(side)'), true);
    assert.equal(isSurroundLayout('stereo'), false);
  });

  it('classifies channel counts', () => {
    assert.equal(classifyAudioProfile(0, ''), 'no-audio');
    assert.equal(classifyAudioProfile(2, 'stereo'), 'stereo');
    assert.equal(classifyAudioProfile(4, 'quad'), 'quadraphonic');
    assert.equal(classifyAudioProfile(4, '4.0'), '4.0-surround');
    assert.equal(classifyAudioProfile(6, '5.1(side)'), '5.1-surround');
    assert.equal(classifyAudioProfile(8, '7.1'), '7.1-surround');
    assert.equal(classifyAudioProfile(12, '12ch'), 'other-multichannel');
  });

  it('only upmixes when there is audio below the target', () => {
    assert.equal(requiresUpmixing(null, 6), false);
    assert.equal(requiresUpmixing(audio(2), 6), true);
    assert.equal(requiresUpmixing(audio(6), 6), false);
  });
});

describe('loudness normalisation', () => {
  it('is skipped entirely when disabled', () => {
    const config = configWith({ audio: { normalization: { enabled: false } } });
    assert.equal(resolveLoudnessTarget(config.audio.normalization), null);
    assert.deepEqual(buildStereoFilterChain(config.audio), []);
  });

  it('resolves the configured preset', () => {
    const config = configWith({ audio: { normalization: { strength: 'broadcast' } } });
    // The named preset is materialised into the explicit fields at normalisation
    // time, so the resolved target reflects it without a second lookup.
    assert.deepEqual(resolveLoudnessTarget(config.audio.normalization), {
      targetLufs: -23,
      truePeak: -1,
      loudnessRange: 7,
    });
  });

  it('spells dual_mono the way each filter chain requires', () => {
    const target = { targetLufs: -16, truePeak: -1.5, loudnessRange: 11 };
    assert.equal(buildLoudnormFilter(target, { dualMono: 'omit' }), MEDIUM_LOUDNORM);
    assert.equal(
      buildLoudnormFilter(target, { dualMono: 'true' }),
      `${MEDIUM_LOUDNORM}:dual_mono=true`,
    );
    assert.equal(
      buildLoudnormFilter(target, { dualMono: 'false' }),
      `${MEDIUM_LOUDNORM}:dual_mono=false`,
    );
  });
});

describe('buildAudioFilterChain', () => {
  it('drives both front channels from a mono source', () => {
    assert.deepEqual(
      buildAudioFilterChain({ channels: 1, channelLayout: 'mono', sampleRate: 48000 }, BASE.audio),
      [
        `${MEDIUM_LOUDNORM}:dual_mono=true`,
        'pan=5.1|FL=c0|FR=c0|FC=0.5*c0|LFE=0.3*c0|BL=0.2*c0|BR=0.2*c0',
        'aresample=48000',
      ],
    );
  });

  it('upmixes stereo to 5.1 at the configured levels', () => {
    assert.deepEqual(
      buildAudioFilterChain(
        { channels: 2, channelLayout: 'stereo', sampleRate: 44100 },
        BASE.audio,
      ),
      [
        `${MEDIUM_LOUDNORM}:dual_mono=true`,
        'pan=5.1|FL=FL|FR=FR|FC=0.5*FL+0.5*FR|LFE=0.3*FL+0.3*FR|BL=0.2*FL|BR=0.2*FR',
        'aresample=44100',
      ],
    );
  });

  it('brings the rate back down after loudnorm', () => {
    // loudnorm measures at 192 kHz and emits at that rate. The AAC encoder tops
    // out at 96 kHz, so without this every normalised file - whatever its source
    // rate - was written at 96 kHz, for twice the samples and no more fidelity.
    // The step goes last: ahead of the pan, ffmpeg fails the graph outright.
    const chain = buildAudioFilterChain(
      { channels: 6, channelLayout: '5.1', sampleRate: 48000 },
      BASE.audio,
    );
    assert.deepEqual(chain, [`${MEDIUM_LOUDNORM}:dual_mono=true`, 'aresample=48000']);

    // An unknown source rate falls back to what video audio normally is, and a
    // chain with no loudnorm in it has no rate to restore.
    assert.deepEqual(
      buildAudioFilterChain({ channels: 6, channelLayout: '5.1', sampleRate: null }, BASE.audio),
      [`${MEDIUM_LOUDNORM}:dual_mono=true`, 'aresample=48000'],
    );
    const unnormalised = configWith({ audio: { normalization: { enabled: false } } });
    assert.deepEqual(
      buildAudioFilterChain(
        { channels: 6, channelLayout: '5.1', sampleRate: 48000 },
        unnormalised.audio,
      ),
      [],
    );
  });

  it('upmixes intermediate channel counts with the resample last', () => {
    assert.deepEqual(
      buildAudioFilterChain({ channels: 3, channelLayout: '2.1', sampleRate: 48000 }, BASE.audio),
      [
        MEDIUM_LOUDNORM,
        'pan=5.1|FL=c0|FR=c1|FC=0.3*c0+0.3*c1|LFE=c2+0.12*c0+0.12*c1|BL=0.24*c0|BR=0.24*c1',
        'aresample=48000',
      ],
    );

    assert.deepEqual(
      buildAudioFilterChain({ channels: 5, channelLayout: '5.0', sampleRate: 48000 }, BASE.audio),
      [
        MEDIUM_LOUDNORM,
        'pan=5.1|FL=c0|FR=c1|FC=c2|LFE=0.3*c0+0.3*c1|BL=c3|BR=c4',
        'aresample=48000',
      ],
    );
  });

  // ffmpeg-static ships without libsoxr, and an `aresample` between the loudnorm
  // and the pan fails the graph even where it is available. Neither is visible
  // from the chain alone, so the rule is asserted rather than left to a comment.
  it('never names a resampler engine, and only ever resamples at the end', () => {
    for (const channels of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const chain = buildAudioFilterChain(
        { channels, channelLayout: deriveChannelLayout(channels), sampleRate: 48000 },
        BASE.audio,
      );
      const resamples = chain.filter((step) => step.indexOf('aresample') === 0);
      assert.deepEqual(
        resamples.filter((step) => step.indexOf('resampler=') !== -1),
        [],
        `channel count ${channels} asked for a specific resampler engine`,
      );
      for (const step of resamples) {
        assert.equal(
          chain.indexOf(step),
          chain.length - 1,
          `channel count ${channels} resamples before the end of the chain`,
        );
      }
    }
  });

  it('leaves an existing multichannel mix alone apart from normalising it', () => {
    assert.deepEqual(
      buildAudioFilterChain({ channels: 6, channelLayout: '5.1', sampleRate: 48000 }, BASE.audio),
      [`${MEDIUM_LOUDNORM}:dual_mono=true`, 'aresample=48000'],
    );
  });

  it('emits nothing at all when there is no audio', () => {
    assert.deepEqual(
      buildAudioFilterChain({ channels: 0, channelLayout: '', sampleRate: null }, BASE.audio),
      [],
    );
  });

  it('honours zero as a real upmix level', () => {
    // The legacy `level || default` idiom silently replaced a configured 0 with
    // its hardcoded default, so a deliberately silent rear channel came back.
    const config = configWith({
      audio: { stereoUpmixing: { rearChannelLevel: 0, centerChannelLevel: 0 } },
    });
    const chain = buildAudioFilterChain(
      { channels: 2, channelLayout: 'stereo', sampleRate: 48000 },
      config.audio,
    );
    assert.equal(chain[1], 'pan=5.1|FL=FL|FR=FR|FC=0*FL+0*FR|LFE=0.3*FL+0.3*FR|BL=0*FL|BR=0*FR');
  });
});

describe('encoding', () => {
  it('caps the bitrate when AAC is forced for compatibility', () => {
    const config = configWith({
      audio: {
        compatibility: { forceAAC: true },
        codecPreferences: { multichannelBitrate: 640000 },
      },
    });
    assert.deepEqual(selectAudioEncoding(6, config.audio), { codec: 'aac', bitrate: 384000 });
    assert.deepEqual(selectAudioEncoding(2, config.audio), { codec: 'aac', bitrate: 256000 });
  });

  it('honours an explicit multichannel codec when AAC is not forced', () => {
    const config = configWith({
      audio: {
        compatibility: { forceAAC: false },
        codecPreferences: { multichannel: 'ac3', multichannelBitrate: 640000 },
      },
    });
    assert.deepEqual(selectAudioEncoding(6, config.audio), { codec: 'ac3', bitrate: 640000 });
  });

  it('resolves performance settings from the selected mode', () => {
    const quiet = configWith({
      performance: { mode: 'quiet', cpuLimiting: { enabled: false } },
    });
    assert.deepEqual(resolvePerformanceSettings(quiet.performance), {
      maxThreads: 1,
      processingDelay: 3000,
      threadQueueSize: 256,
      priority: 'low',
    });
  });

  it('lets an enabled cpuLimiting block override the preset', () => {
    const config = configWith({
      performance: {
        mode: 'quiet',
        cpuLimiting: { enabled: true, maxThreads: 4, processingDelay: 0, threadQueueSize: 1024 },
      },
    });
    assert.equal(resolvePerformanceSettings(config.performance).maxThreads, 4);
  });

  it('throttles ffmpeg further when limited to a single thread', () => {
    const single = buildPerformanceOutputOptions({
      maxThreads: 1,
      processingDelay: 0,
      threadQueueSize: 256,
      priority: 'low',
    });
    assert.deepEqual(single, [
      '-threads',
      '1',
      '-thread_queue_size',
      '256',
      '-preset',
      'medium',
      '-cpu-used',
      '1',
    ]);

    const dual = buildPerformanceOutputOptions({
      maxThreads: 2,
      processingDelay: 0,
      threadQueueSize: 512,
      priority: 'normal',
    });
    assert.equal(dual.includes('-cpu-used'), false);
  });
});

describe('planTranscode', () => {
  it('produces a 5.1 plan for a stereo source', () => {
    const plan = planTranscode(audio(2), BASE, { compatibilityMode: false });
    assert.equal(plan.outputChannels, 6);
    assert.equal(plan.audioEncoding.codec, 'aac');
    // loudnorm, the resample that undoes its rate change, then the 5.1 pan.
    assert.equal(plan.audioFilters.length, 3);
    assert.deepEqual(plan.outputOptions.slice(-MP4_OUTPUT_OPTIONS.length), MP4_OUTPUT_OPTIONS);
  });

  it('falls back to stereo in compatibility mode', () => {
    const plan = planTranscode(audio(2), BASE, { compatibilityMode: true });
    assert.equal(plan.outputChannels, null);
    assert.deepEqual(plan.audioEncoding, { codec: 'aac', bitrate: 256000 });
    // The retry path normalises too, so it needs the same rate restored: the
    // source's own 48 kHz rather than the 96 kHz loudnorm would otherwise leave.
    assert.deepEqual(plan.audioFilters, [
      `${MEDIUM_LOUDNORM}:dual_mono=true`,
      'aresample=48000',
    ]);
  });

  it('does not upmix when only one or two channels were asked for', () => {
    // The pan used to run anyway and `-ac 2` folded it straight back down,
    // which put audible crosstalk into a hard-panned mix and cost about 4 dB
    // against the loudness target.
    const config = configWith({ audio: { forceOutputChannels: 2 } });
    const plan = planTranscode(audio(2), config, { compatibilityMode: false });

    assert.equal(
      plan.audioFilters.some((filter) => filter.startsWith('pan=')),
      false,
    );
    // Still applied, so a real 5.1 source is downmixed once, by ffmpeg.
    assert.equal(plan.outputChannels, 2);
    assert.equal(plan.audioEncoding.bitrate, 256000);
    // The rate restore survives, since loudnorm is still in the chain.
    assert.deepEqual(plan.audioFilters, [
      `${MEDIUM_LOUDNORM}:dual_mono=true`,
      'aresample=48000',
    ]);
  });

  it('still upmixes stereo to 5.1 on the default channel count', () => {
    // The fix above must not touch the default path: a stereo source is what
    // the upmix exists for, and six channels is what comes out of it.
    const plan = planTranscode(audio(2), BASE, { compatibilityMode: false });
    assert.equal(BASE.audio.outputChannels, 6);
    assert.equal(plan.outputChannels, 6);
    assert.equal(
      plan.audioFilters.some((filter) => filter.startsWith('pan=5.1')),
      true,
    );
  });

  it('falls back to stereo when surround processing is switched off', () => {
    const config = configWith({ audio: { enabled51Processing: false } });
    const plan = planTranscode(audio(2), config, { compatibilityMode: false });
    assert.equal(plan.outputChannels, null);
  });

  it('handles a source with no audio track', () => {
    const plan = planTranscode(null, BASE, { compatibilityMode: false });
    assert.deepEqual(plan.audioFilters, []);
  });
});
