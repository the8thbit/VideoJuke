import { readdir } from 'node:fs/promises';

import { fromRoot, logStep, main, removeDirectory, run, runTsc } from './lib/run.mjs';

main(async () => {
  logStep('Compiling tests');
  await removeDirectory(fromRoot('.tsbuild/test'));
  await runTsc(['-p', 'tsconfig.test.json']);

  logStep('Running tests');
  // Enumerate explicitly: the runner's directory discovery does not resolve a
  // Windows absolute path the way a bare glob would.
  const testDirectory = fromRoot('.tsbuild/test/tests');
  const entries = await readdir(testDirectory);
  const testFiles = entries.filter((name) => name.endsWith('.test.js')).sort();

  if (testFiles.length === 0) throw new Error('No compiled test files found');

  await run(process.execPath, [
    '--test',
    ...testFiles.map((name) => `${testDirectory}/${name}`),
  ]);
});
