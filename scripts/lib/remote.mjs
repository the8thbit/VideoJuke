/**
 * Whether this working copy has fallen behind the branch it tracks.
 *
 * The launcher already refuses to start yesterday's *build*; this answers the
 * same question one level up, about the *source*. It is deliberately timid:
 * every branch below either fast-forwards or declines, because the alternative
 * to declining is resolving a merge on a machine whose owner is at that moment
 * double-clicking a Start Menu icon expecting to watch television.
 */
import { capture, fromRoot, pathExists } from './run.mjs';

/**
 * How long the network is allowed to hold up a launch.
 *
 * The whole point of the staleness check is that it costs milliseconds when
 * there is nothing to do, and a fetch is the one part of this that can hang: a
 * laptop on a captive-portal wifi, a VPN that is half up, a host that answers
 * the TCP connection and then nothing. Ten seconds is long enough for a slow
 * link and short enough that nobody wonders whether the shortcut worked.
 */
export const FETCH_TIMEOUT_MS = 10000;

/**
 * The environment a fetch runs in.
 *
 * Every one of these stops git asking a question. A shortcut launched from the
 * Start Menu may have no console at all, so a credential prompt does not appear
 * anywhere - it simply waits for an answer that cannot arrive, and the deadline
 * above is the only thing that ends it. Failing fast and starting the app is a
 * far better outcome than a player that does not open.
 */
const NON_INTERACTIVE = {
  GIT_TERMINAL_PROMPT: '0',
  // An askpass that answers with nothing, so a credential helper that would
  // have popped a window fails immediately instead.
  GIT_ASKPASS: 'echo',
  SSH_ASKPASS: 'echo',
  // BatchMode covers a passphrase-protected key and an unknown host key, which
  // are the two ways ssh blocks forever.
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
};

/**
 * What to do about the remote, given everything already known about the repo.
 *
 * Pure, and separate from the commands that answer those questions, because the
 * interesting part of this feature is the decision - "when is it safe to move
 * someone's working copy underneath them?" - and that should be readable in one
 * screen rather than spread through a sequence of subprocess calls.
 */
export const decideRemoteAction = (facts) => {
  if (!facts.isRepository) {
    return { action: 'skip', reason: 'this copy is not a git checkout' };
  }
  if (facts.branch === null) {
    return { action: 'skip', reason: 'HEAD is detached, so there is no branch to update' };
  }
  if (facts.upstream === null) {
    return { action: 'skip', reason: `${facts.branch} does not track a remote branch` };
  }
  if (!facts.fetched) {
    // Not an error the launcher should dwell on: being offline is the normal
    // state of a laptop that has been carried somewhere.
    return { action: 'skip', reason: `could not reach ${facts.upstream} (${facts.fetchProblem})` };
  }
  if (facts.behind === 0) {
    return { action: 'current', reason: `up to date with ${facts.upstream}` };
  }
  if (facts.ahead > 0) {
    // A merge, and merges have conflicts. Whoever made those local commits is
    // the right person to decide what happens to them, at a keyboard, later.
    return {
      action: 'skip',
      reason:
        `${facts.branch} has diverged from ${facts.upstream} ` +
        `(${facts.ahead} local, ${facts.behind} remote); pull it by hand`,
    };
  }
  if (facts.dirty) {
    return {
      action: 'skip',
      reason: `${facts.behind} new commits are waiting, but there are uncommitted changes here`,
    };
  }
  return {
    action: 'pull',
    reason: `${facts.behind} new commit${facts.behind === 1 ? '' : 's'} on ${facts.upstream}`,
  };
};

const git = (args, options = {}) => capture('git', args, { env: NON_INTERACTIVE, ...options });

/** Why a fetch failed, in a few words rather than git's several lines. */
const describeFetchFailure = (result) => {
  if (result.timedOut) return `no answer within ${FETCH_TIMEOUT_MS}ms`;
  if (result.error !== undefined) return result.error.message;
  const firstLine = result.stderr.split('\n').find((line) => line.trim() !== '');
  return firstLine === undefined ? `git exited with code ${result.code}` : firstLine.trim();
};

/** Asks the repository every question {@link decideRemoteAction} needs. */
export const inspectRemote = async () => {
  if (!(await pathExists(fromRoot('.git')))) {
    return decideRemoteAction({ isRepository: false });
  }

  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  // `git rev-parse --abbrev-ref HEAD` answers the literal string HEAD when
  // nothing is checked out by name.
  const branch = head.ok && head.stdout !== 'HEAD' && head.stdout !== '' ? head.stdout : null;
  if (branch === null) return decideRemoteAction({ isRepository: true, branch: null });

  const tracked = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = tracked.ok && tracked.stdout !== '' ? tracked.stdout : null;
  if (upstream === null) {
    return decideRemoteAction({ isRepository: true, branch, upstream: null });
  }

  const fetched = await git(['fetch', '--quiet'], { timeoutMs: FETCH_TIMEOUT_MS });
  if (!fetched.ok) {
    return decideRemoteAction({
      isRepository: true,
      branch,
      upstream,
      fetched: false,
      fetchProblem: describeFetchFailure(fetched),
    });
  }

  // One command for both numbers, so they cannot describe two different moments.
  const counts = await git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
  const [ahead, behind] = counts.ok
    ? counts.stdout.split(/\s+/).map((value) => Number(value))
    : [0, 0];

  const status = await git(['status', '--porcelain']);

  return decideRemoteAction({
    isRepository: true,
    branch,
    upstream,
    fetched: true,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
    // A repository we cannot read the status of is treated as dirty: the timid
    // answer is the right one when the question is whether to overwrite files.
    dirty: !status.ok || status.stdout !== '',
  });
};

/**
 * Fast-forwards the checkout.
 *
 * `merge --ff-only` rather than `pull`: pull is configurable, and a user with
 * `pull.rebase=true` would have this quietly rewriting their history. The
 * caller has already established that a fast-forward is possible, so the only
 * failures left are ones nobody predicted - which is why this still reports
 * rather than throws.
 */
export const pullFastForward = async () => {
  const merged = await git(['merge', '--ff-only', '@{u}']);
  return merged.ok
    ? { pulled: true, reason: merged.stdout.split('\n')[0] ?? 'fast-forwarded' }
    : { pulled: false, reason: describeFetchFailure(merged) };
};
