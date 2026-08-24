import * as esbuild from 'esbuild';

import {
  copyInto,
  ensureDirectory,
  fromRoot,
  isMissingCommand,
  logStep,
  main,
  pathExists,
  removeDirectory,
  run,
  runTsc,
} from './lib/run.mjs';

const PACKAGE_DIR = fromRoot('build/webos/package');
const OUTPUT_DIR = fromRoot('release/webos');

const ASSETS = [
  'index.html',
  'webos.css',
  'appinfo.json',
  'icon.png',
  'largeIcon.png',
  'webOSTVjs-1.2.12',
];

/**
 * webOS TVs run an old Chromium, so the app is compiled to ES5 by TypeScript
 * and then bundled by esbuild. This replaces a hand-written regular-expression
 * transpiler that rewrote const, template literals and arrow functions by
 * pattern matching, which broke on any syntax it had not been taught about.
 */
main(async () => {
  logStep('Cleaning webOS build output');
  await removeDirectory(fromRoot('build/webos'));
  await removeDirectory(fromRoot('.tsbuild/webos'));
  await ensureDirectory(PACKAGE_DIR);

  logStep('Compiling webOS client to ES5');
  await runTsc(['-p', 'tsconfig.webos.json']);

  logStep('Bundling webOS client');
  await esbuild.build({
    entryPoints: [fromRoot('.tsbuild/webos/client/webos/main.js')],
    outfile: `${PACKAGE_DIR}/client.js`,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es5'],
    logLevel: 'warning',
  });

  logStep('Copying webOS assets');
  await copyInto(fromRoot('src/client/core/styles/player.css'), `${PACKAGE_DIR}/player.css`);
  for (const asset of ASSETS) {
    const copied = await copyInto(fromRoot('src/client/webos', asset), `${PACKAGE_DIR}/${asset}`);
    process.stdout.write(`  ${copied ? 'copied' : 'skipped (missing)'} ${asset}\n`);
  }

  if (!(await pathExists(`${PACKAGE_DIR}/webOSTVjs-1.2.12`))) {
    process.stdout.write(
      '\nThe webOS TV library is missing. Download it from\n' +
        '  https://webostv.developer.lge.com/develop/tools/webos-tv-library\n' +
        `and extract it to src/client/webos/webOSTVjs-1.2.12.\n`,
    );
  }

  logStep('Packaging with ares-package');
  await ensureDirectory(OUTPUT_DIR);
  try {
    await run('ares-package', ['.', '-o', OUTPUT_DIR], { cwd: PACKAGE_DIR });
    process.stdout.write(
      `\nPackage written to ${OUTPUT_DIR}.\n` +
        'Install it with: ares-install <path-to-ipk>\n',
    );
  } catch (error) {
    // Only a missing toolchain is tolerated, which is what this branch was for:
    // the unpackaged app is still useful and the README says so. Reporting a
    // packaging run that actually failed the same way - and exiting 0 - hid real
    // failures behind "install the SDK", including a packaging path that was
    // simply mis-quoted.
    if (!isMissingCommand(error)) throw error;

    process.stdout.write(
      `\nares-package is unavailable (${error instanceof Error ? error.message : String(error)}).\n` +
        `The unpackaged app is ready in ${PACKAGE_DIR}.\n` +
        'Install the webOS CLI tools from https://webostv.developer.lge.com/sdk/installation/ to build an IPK.\n',
    );
  }
});
