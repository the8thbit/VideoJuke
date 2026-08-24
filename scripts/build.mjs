import * as esbuild from 'esbuild';

import { copyInto, fromRoot, logStep, main, removeDirectory, runTsc } from './lib/run.mjs';

const isWatch = process.argv.includes('--watch');

/**
 * Electron 36 ships Chromium 136, so the renderer can be built for a modern
 * engine. The web client targets a far older baseline because it also has to
 * run in whatever browser a user points at the server.
 */
const CLIENT_BUNDLES = [
  {
    label: 'electron renderer',
    entryPoints: [fromRoot('src/client/electron/main.ts')],
    outfile: fromRoot('dist/client/electron/client.js'),
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
  },
  {
    label: 'electron preload',
    entryPoints: [fromRoot('src/client/electron/preload.ts')],
    outfile: fromRoot('dist/client/electron/preload.js'),
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    external: ['electron'],
  },
  {
    label: 'web client',
    entryPoints: [fromRoot('src/client/web/main.ts')],
    outfile: fromRoot('dist/client/web/client.js'),
    format: 'iife',
    platform: 'browser',
    target: ['es2017', 'chrome80', 'firefox78', 'safari13', 'edge88'],
  },
];

const STATIC_FILES = [
  ['src/client/electron/index.html', 'dist/client/electron/index.html'],
  ['src/client/electron/electron.css', 'dist/client/electron/electron.css'],
  ['src/client/core/styles/player.css', 'dist/client/electron/player.css'],
  ['src/client/web/index.html', 'dist/client/web/index.html'],
  ['src/client/web/web.css', 'dist/client/web/web.css'],
  ['src/client/core/styles/player.css', 'dist/client/web/player.css'],
];

const toBuildOptions = ({ label: _label, ...options }) => ({
  ...options,
  bundle: true,
  sourcemap: true,
  logLevel: 'warning',
});

main(async () => {
  logStep('Cleaning dist');
  await removeDirectory(fromRoot('dist'));
  // The incremental state has to go with the output it describes. Left behind,
  // tsc -b decides everything is up to date and emits nothing at all.
  await removeDirectory(fromRoot('.tsbuild'));

  logStep('Compiling server and shared sources');
  await runTsc(['-b', 'tsconfig.server.json']);

  logStep('Type-checking client sources');
  await runTsc(['-b', 'tsconfig.client.json']);

  logStep('Bundling clients');
  if (isWatch) {
    const contexts = await Promise.all(CLIENT_BUNDLES.map((bundle) => esbuild.context(toBuildOptions(bundle))));
    await Promise.all(contexts.map((context) => context.watch()));
    process.stdout.write('Watching client bundles. Press Ctrl+C to stop.\n');
  } else {
    for (const bundle of CLIENT_BUNDLES) {
      await esbuild.build(toBuildOptions(bundle));
      process.stdout.write(`  built ${bundle.label}\n`);
    }
  }

  logStep('Copying static assets');
  for (const [source, destination] of STATIC_FILES) {
    await copyInto(fromRoot(source), fromRoot(destination));
    process.stdout.write(`  copied ${source}\n`);
  }

  logStep('Build complete');
});
