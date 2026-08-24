import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from './run.mjs';

/**
 * Where a per-user Start Menu entry belongs.
 *
 * Per user rather than all users: the all-users folder needs administrator
 * rights, and this shortcut points at one person's working copy of a repository.
 */
export const startMenuDirectory = () =>
  join(
    process.env['APPDATA'] ?? join(process.env['USERPROFILE'] ?? '', 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
  );

/**
 * Creates a Windows `.lnk`.
 *
 * Through PowerShell's `WScript.Shell`, which is how a shortcut has been made on
 * Windows for twenty years and needs nothing installed. The script goes to a
 * file and its values arrive as named parameters rather than being interpolated
 * into a command line: every one of these paths can contain a space, and the
 * Start Menu's own path always does.
 */
export const createShortcut = async ({
  shortcutPath,
  targetPath,
  args,
  workingDirectory,
  description,
  iconLocation,
}) => {
  const script = join(tmpdir(), `videojuke-shortcut-${process.pid}.ps1`);
  await writeFile(
    script,
    [
      'param(',
      // Not `$Args`: that is a PowerShell automatic variable, and a parameter
      // by that name never binds - the shortcut is created with no arguments at
      // all, which is a launcher that launches nothing.
      '  [string]$ShortcutPath, [string]$TargetPath, [string]$LinkArguments,',
      '  [string]$WorkingDirectory, [string]$Description, [string]$IconLocation',
      ')',
      '$ErrorActionPreference = "Stop"',
      '$shell = New-Object -ComObject WScript.Shell',
      '$link = $shell.CreateShortcut($ShortcutPath)',
      '$link.TargetPath = $TargetPath',
      '$link.Arguments = $LinkArguments',
      '$link.WorkingDirectory = $WorkingDirectory',
      '$link.Description = $Description',
      'if ($IconLocation -ne "") { $link.IconLocation = $IconLocation }',
      '$link.Save()',
    ].join('\n'),
    'utf8',
  );

  try {
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-ShortcutPath', shortcutPath,
      '-TargetPath', targetPath,
      '-LinkArguments', args,
      '-WorkingDirectory', workingDirectory,
      '-Description', description,
      '-IconLocation', iconLocation ?? '',
    ]);
  } finally {
    await rm(script, { force: true });
  }
};

/** Reads a `.lnk` back, so an install can prove it made what it meant to. */
export const readShortcut = async (shortcutPath) => {
  const script = join(tmpdir(), `videojuke-read-${process.pid}.ps1`);
  const output = join(tmpdir(), `videojuke-read-${process.pid}.json`);
  await writeFile(
    script,
    [
      'param([string]$ShortcutPath, [string]$OutputPath)',
      '$ErrorActionPreference = "Stop"',
      '$shell = New-Object -ComObject WScript.Shell',
      '$link = $shell.CreateShortcut($ShortcutPath)',
      '$result = @{',
      '  TargetPath = $link.TargetPath',
      '  Arguments = $link.Arguments',
      '  WorkingDirectory = $link.WorkingDirectory',
      '  Description = $link.Description',
      '}',
      // `Set-Content -Encoding utf8` writes a byte-order mark on Windows
      // PowerShell 5.1, which JSON.parse refuses. .NET writes UTF-8 without one.
      '[System.IO.File]::WriteAllText($OutputPath, ($result | ConvertTo-Json -Compress))',
    ].join('\n'),
    'utf8',
  );

  try {
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-ShortcutPath', shortcutPath,
      '-OutputPath', output,
    ]);
    const { readFile } = await import('node:fs/promises');
    // Belt and braces: a future PowerShell, or a different host, may still
    // prepend a mark, and one stray character would fail the whole install.
    return JSON.parse((await readFile(output, 'utf8')).replace(/^﻿/, ''));
  } finally {
    await rm(script, { force: true });
    await rm(output, { force: true });
  }
};
