# VideoJuke architecture

## Shape of the system

VideoJuke is one application with two servers and three clients.

- A **server** owns the filesystem: it indexes source directories, transcodes
  videos with ffmpeg into a temp directory, keeps a queue of ready videos, and
  remembers what has been played. It runs either inside Electron's main process
  or as a standalone HTTP server.
- A **client** owns the screen: it keeps a small playback queue, drives two
  `<video>` elements, crossfades between them, and handles input. It runs as an
  Electron renderer, a browser page, or a webOS TV app.

Client and server meet at exactly one interface, `PlayerApi`
(`src/shared/types/protocol.ts`). Electron implements it over IPC, browsers over
HTTP plus a WebSocket. Nothing else crosses the boundary, and the client code
never learns which transport it is using.

```
src/
  shared/    platform-neutral types and pure logic (no node, no dom)
  server/    node-only: filesystem, ffmpeg, express, electron main
  client/    dom-only: player, queue, ui, input, transports
```

## Layering rules

1. `shared/` may not import from `server/` or `client/`, and may not touch
   `node:*`, `window`, or `document`. It is compiled twice — once against the
   Node lib and once against the DOM lib — so a stray global breaks the build.
2. `server/infra/` is the only place in the server that performs I/O. Domain
   modules receive their effects as injected dependencies.
3. `client/core/` is shared by all three clients. Per-platform folders
   (`client/electron`, `client/web`, `client/webos`) contain only an entry point
   and whatever genuinely differs.

## Functional core, imperative shell

Decisions are pure functions; effects are thin shells around them.

- Pure, in `shared/`: config merging and validation, time-condition evaluation,
  ffmpeg filter and codec selection, crossfade timing, random selection,
  history transitions, formatting.
- Effectful, in `server/infra` and `client/core`: reading files, spawning
  ffmpeg, serving HTTP, mutating the DOM, timers.

Concretely this means:

- **Data is immutable.** Domain values are `readonly` all the way down.
  Transitions return a new value rather than mutating in place.
- **Mutable cells are explicit.** Where live state is genuinely needed (the
  preprocess queue, playback history, the DOM), it lives in a `Store`
  (`shared/state/store.ts`) whose only mutator is `update(previous => next)`.
  There are no ad-hoc `this.foo = bar` state machines.
- **Failure is a value.** Fallible operations return `Result<T, E>`
  (`shared/types/result.ts`) instead of throwing or returning `null` with a log
  line. Exceptions are caught at the shell boundary and converted.
- **Dependencies are parameters.** Clock, random source, id generator, logger
  and filesystem are passed in, which is what makes the core testable.

## Configuration

`config.default.json` is the complete set of defaults. `config.json` holds only
a user's overrides. They are merged and validated exactly once, at startup, by
`shared/config/normalize.ts`, which produces an `AppConfig` where every field is
present and in range, plus a list of `ConfigIssue`s to log.

Downstream code therefore reads `config.video.preprocessedQueueSize` directly.
The old `config?.a?.b ?? fallback` pattern is a bug, not a style choice: it
scatters defaults across dozens of call sites where they silently drift apart.

Clients receive `ClientConfig`, a `Pick` of the sections they actually need;
directory listings and ffmpeg tuning never leave the server.

## What the server will act on

A video record is three strings and some metadata, and two of those strings are
filesystem paths the server acts on directly: it feeds `originalPath` to ffmpeg
and it `unlink`s `processedPath`. Records do not only come from the scan. They
arrive in HTTP bodies, in IPC payloads, and out of cache files an earlier run
wrote — none of which this process produced in this run, and the first of which
any page on the network can send.

So paths are checked, not trusted (`server/domain/videoPaths.ts`):

- a **transcode** must resolve inside the temp directory,
- a **source** must resolve inside a directory the user configured,
- and neither may contain `..`, a bare `.`, or a NUL.

The gate goes at both ends. Every transport decodes with it, so a bad record
never reaches session state; and the two places that delete a file check again
before unlinking, so a cache file poisoned by an older build cannot cash in. The
temp sweep is narrower still: it only removes files matching the name the
preprocessor writes, because `system.tempDirectory` is a path the user chooses
and it may not be empty.

Playback history is the one deliberate exception. Its entries are a record of
what was watched, keyed by the source file, and the temp directory moves
whenever the app is started from a different working directory — so history is
read with the transcode check relaxed. That is safe precisely because the
deletion sinks do their own checking.

## Access control

The web server refuses to run without a shared secret and mints one on first
start. Only that host: Electron speaks to its own process over IPC and `npm run
archive` touches no network, so neither has anything to authenticate.

Three surfaces, two mechanisms. The API and the WebSocket take the secret
directly — a bearer header, and the WebSocket subprotocol list, which is the only
header a browser lets a page set on an upgrade. The stream route cannot: a
`<video>` element sends no headers. So `toStreamLocation`, already the single
place stream URLs are built, signs each one with an HMAC over the filename and an
expiry. The secret stays out of URLs, and a signed URL authorises exactly one
file until it ages out.

That constraint is also why a leader broadcasts a `PreprocessedVideo` and never a
`PlayableVideo`: `location` holds a signed URL minted for one client, and putting
one on the wire would hand every other screen a credential that expires
mid-video. Followers mint their own.

## Multi-screen sync

One screen leads and publishes what it is playing; the others follow. The role is
per client — the browser reads it from the URL, Electron from `--role=`, the TV
from its setup screen — because `ClientConfig` is shared by everything that
connects and so cannot say that one particular screen leads.

Two things shape the protocol.

The **TV has no WebSocket**: `webos/main.ts` disables it because the set accepts
an upgrade and then delivers nothing. So polling is the transport and the push is
only an early wake-up. That costs nothing, because the poll is needed anyway —
its round trip is how a follower measures its clock against the server's.

**No two devices compare clocks.** The server restamps every publication with its
own `clock.now()`, and followers estimate their offset to the server from the
poll, keeping the sample with the shortest round trip. A TV that has never
reached a time server is routinely hours out; nothing in this design cares.

A follower builds no playback queue at all. Not merely an unmonitored one: a
queue would drain the shared server pool, and its mirror would overwrite the
leader's protected set and let the temp sweep delete the video on screen.

Convergence is proportional only, on a trim held separately from
`PlayerSnapshot.speed`. Separate because `speed` is what the viewer asked for —
it is displayed, and `adjustSpeed` steps from it — while the trim is a correction
of a percent or two arriving four times a second. Proportional only because
position is already the integral of rate, so an integral term is how such a loop
learns to overshoot.

## Archiving

Flagging a video writes to `flagged_for_archive.json` and nothing else. Moving
files is a separate entry point, `server/archive`, run by `npm run archive` while
the player is stopped — the running server owns the temp directory and may be
mid-transcode, and moving a source out from under it is not a race worth having.

That split is why the flag list lives beside `config.json` rather than in
`cache/`: it records a decision a person made, which nothing can recompute, so it
has to survive a cache the app is otherwise free to delete. It is also the reason
the list is written through on every toggle instead of on the save timer.

The archive directory is excluded from the scan, including when it sits inside a
source directory, which is the obvious place to put it.

## Naming conventions

- Files are `camelCase.ts` and export named symbols; no default exports.
- Types and interfaces are `PascalCase`; values and functions are `camelCase`;
  module-level constants are `SCREAMING_SNAKE_CASE`.
- Factory functions are `createX`; pure derivations are `toX` / `deriveX` /
  `selectX`; predicates are `isX` / `hasX`; effectful commands are verbs.
- Durations carry their unit when it is not milliseconds (`durationSeconds`).
  Every field in `TimeoutsConfig` is milliseconds.

## Testing

`tests/` holds `node:test` suites for the pure core — config normalisation,
time conditions, audio filter construction, crossfade timing, history and
selection. They run without ffmpeg, a browser, or a filesystem:
`npm test`.

## Build

| Target            | Pipeline                                                        | Output                       |
| ----------------- | --------------------------------------------------------------- | ---------------------------- |
| Server + Electron | `tsc` → CommonJS                                                 | `dist/server`, `dist/shared` |
| Electron renderer | `esbuild` → IIFE, Chromium target                                | `dist/client/electron`       |
| Web client        | `esbuild` → IIFE, ES2017 target                                  | `dist/client/web`            |
| webOS TV          | `tsc` → ES5, then `esbuild` → IIFE bundle, plus small polyfills | `build/webos/package`        |

The webOS path replaces a hand-written regular-expression transpiler that
rewrote `const`, template literals and arrow functions by pattern matching. A
real compiler removes that entire class of failure.
