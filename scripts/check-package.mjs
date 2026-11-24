/**
 * electron-builder `afterPack` hook: refuses to build an installer that carries
 * anything of the person who built it.
 *
 * The app's own working folder holds config.json (with the web server's access
 * token), the video index (every path in the library), playback history and the
 * transcodes themselves. `build.files` in package.json is a whitelist that keeps
 * them out, but it is easy to break: a platform-level `files` list replaces it
 * rather than adding to it, and the first installer built that way shipped all
 * of the above. This check looks at what was actually packed, so the next such
 * mistake fails the build instead of reaching another machine.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

/** Top-level entries an installer must never contain. */
const FORBIDDEN = [
  'config.json',
  'cache',
  'temp',
  'archive',
  'flagged_for_archive.json',
  'favorites.json',
  'src',
  'tests',
  '.tsbuild',
];

export default async function checkPackage(context) {
  const archive = join(context.appOutDir, 'resources', 'app.asar');
  const entries = Object.keys(asar.getRawHeader(archive).header.files ?? {});
  const found = entries.filter((entry) => FORBIDDEN.includes(entry));
  if (found.length > 0) {
    throw new Error(
      `refusing to package: the app archive contains ${found.join(', ')}. ` +
        'Check build.files in package.json - only dist, config.default.json and package.json belong in it.',
    );
  }
  process.stdout.write(`  • package check passed: ${entries.sort().join(', ')}\n`);
}
