import type { AudioProfile, AudioStreamInfo } from '../types/video';

/**
 * Layout names for the channel counts ffmpeg has a word for. OPUS and a few
 * other codecs report a channel count with no `channel_layout` at all, so the
 * name has to be reconstructed before anything downstream can branch on it.
 */
const CHANNEL_LAYOUT_NAMES: Readonly<Record<number, string>> = {
  1: 'mono',
  2: 'stereo',
  3: '2.1',
  4: 'quad',
  5: '5.0',
  6: '5.1',
  8: '7.1',
};

/** Names the layout ffprobe omitted, falling back to `${channels}ch`. */
export const deriveChannelLayout = (channels: number): string =>
  CHANNEL_LAYOUT_NAMES[channels] ?? `${channels}ch`;

/** The two spellings ffmpeg uses for 5.1; they differ only in surround placement. */
export const isSurroundLayout = (channelLayout: string): boolean =>
  channelLayout === '5.1' || channelLayout === '5.1(side)';

/**
 * Buckets a stream by what its channels actually address. Counts that match no
 * known speaker arrangement collapse to `other-multichannel`, where the legacy
 * code produced an open-ended `${channels}-channel` string that nothing parsed.
 */
export const classifyAudioProfile = (channels: number, channelLayout: string): AudioProfile => {
  if (channels === 0 || Number.isNaN(channels)) return 'no-audio';
  if (channels === 1) return 'mono';
  if (channels === 2) return 'stereo';
  if (channels === 6 && isSurroundLayout(channelLayout)) return '5.1-surround';
  if (channels === 8 && channelLayout === '7.1') return '7.1-surround';
  if (channels === 3) return '2.1-surround';
  if (channels === 4) return channelLayout === 'quad' ? 'quadraphonic' : '4.0-surround';
  if (channels === 5) return '5.0-surround';
  return 'other-multichannel';
};

/** True when there is audio to upmix and it has fewer channels than the target. */
export const requiresUpmixing = (audio: AudioStreamInfo | null, targetChannels: number): boolean =>
  audio !== null && audio.channels >= 1 && audio.channels < targetChannels;
