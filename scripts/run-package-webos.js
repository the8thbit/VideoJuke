#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const isWindows = os.platform() === 'win32';
const scriptDir = __dirname;

// Choose the appropriate script based on platform
const scriptFile = isWindows ? 'package-webos.bat' : 'package-webos.sh';
const scriptPath = path.join(scriptDir, scriptFile);

console.log(`Running ${scriptFile}...`);

// Spawn the appropriate script
const child = isWindows
    ? spawn('cmd.exe', ['/c', scriptPath], { stdio: 'inherit', shell: true })
    : spawn('bash', [scriptPath], { stdio: 'inherit' });

child.on('error', (error) => {
    console.error(`Error running packaging script: ${error.message}`);
    process.exit(1);
});

child.on('exit', (code) => {
    process.exit(code);
});