import type { LeaderPublication } from '../../shared/types/protocol';
import { readField } from '../../shared/util/decode';
import { parseNumber } from '../../shared/util/numbers';
import { decodePreprocessedVideo } from './videoRecords';
import type { VideoPathGuard } from './videoPaths';

/**
 * The range a media element will accept for `playbackRate`, as `normalize.ts`
 * uses. A follower writes the leader's rate straight onto its own element, so a
 * value outside this range would be refused there rather than here.
 */
const MIN_RATE = 0.0625;
const MAX_RATE = 16;

/**
 * Reads what a leading screen says it is playing.
 *
 * There is one of these because there were two, and they had drifted. Electron
 * and the web server each decoded `LeaderPublication` by hand: the HTTP side
 * read the record out of `body.video` and clamped the rate and the position, the
 * IPC side decoded the wrapper object itself - finding no `originalPath` on it -
 * and clamped nothing. So an Electron leader answered null to every publication
 * and silently never led, while a renderer could publish a negative rate that
 * the web server would have refused.
 *
 * The payload is the least trusted input the server has: `cors()` makes the HTTP
 * route reachable from any page the user happens to have open, so the video goes
 * through the same path guard as every other record and every number is brought
 * into a range a player can act on.
 */
export const decodeLeaderPublication = (
  payload: unknown,
  guard: VideoPathGuard,
): LeaderPublication | null => {
  // Wrapped or bare. `LeaderPublication` nests the record under `video`, which
  // is the shape both transports send; a bare record is accepted so an older
  // client that flattened it into the body still publishes.
  const wrapped = readField(payload, 'video');
  const video = decodePreprocessedVideo(wrapped === undefined ? payload : wrapped, guard);
  if (video === null) return null;

  const position = parseNumber(readField(payload, 'positionSeconds'));
  const rate = parseNumber(readField(payload, 'rate'));

  return {
    video,
    // A negative position would put the leader before the start of its own
    // video, and every follower would seek backwards to reach it.
    positionSeconds: position === null || position < 0 ? 0 : position,
    paused: readField(payload, 'paused') === true,
    rate: rate === null || rate < MIN_RATE || rate > MAX_RATE ? 1 : rate,
  };
};
