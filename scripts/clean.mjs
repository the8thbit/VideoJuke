import { fromRoot, logStep, main, removeDirectory } from './lib/run.mjs';

const GENERATED = ['dist', 'build', 'release', '.tsbuild'];

main(async () => {
  for (const directory of GENERATED) {
    logStep(`Removing ${directory}`);
    await removeDirectory(fromRoot(directory));
  }
});
