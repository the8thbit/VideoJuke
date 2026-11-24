# Working in this repository

## After every requested change

1. Bump the version in `package.json` (`npm version <x.y.z> --no-git-tag-version`,
   which updates package-lock.json too), following semantic versioning:
   - minor (1.1.0 to 1.2.0) for a new feature or a change in behaviour;
   - patch (1.2.0 to 1.2.1) for a bug fix only;
   - major only when the user asks for it.
   A change that cannot affect the app (docs, tests or this file alone) keeps
   the version. Say the new version number in the reply.
2. Commit on a short-lived feature branch, fast-forward `master` to it, and
   push `master`. Run these in the background, and report the change as done
   without waiting for the push to finish.
3. Rebuild the Windows installer in the background with
   `npm run package:electron`. It writes `release\VideoJuke Setup <version>.exe`,
   which is the only file needed to install on another machine. Say when the
   rebuild has finished, or if it failed. A change that cannot affect the app
   (docs, tests or this file alone) needs no rebuild.

Commits are credited to the user alone: add no co-author trailer.

## Conventions

- There is no Prettier config, so never run prettier: it reformats whole files.
- Working files are CRLF (`core.autocrlf=true`). Keep the line endings a file
  already has.
- `config.default.json` must normalize to exactly `DEFAULT_CONFIG` in
  `src/shared/config/defaults.ts`. Change both together.
- `src/shared` and `src/client/core` are also compiled to ES5 for the webOS
  build (`tsconfig.webos.json`). Avoid Map, Set and newer string or array
  methods there.
- Check with `npm run typecheck`, `npx tsc -p tsconfig.webos.json --noEmit` and
  `npm test`.
