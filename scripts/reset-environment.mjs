#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isDryRun = process.argv.includes('--dry-run');
const skipDelay = isDryRun || process.argv.includes('-f') || process.argv.includes('--force');
let started = false;

process.on('SIGINT', () => {
  console.log(
    started
      ? '\nReset interrupted; some changes may already have been made.'
      : '\nReset cancelled. No changes were made.'
  );
  process.exit(130);
});

function remove(target) {
  if (!fs.existsSync(target)) return;
  if (isDryRun) {
    console.log(`[DRY-RUN] Remove ${target}`);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
}

function removeLoginItem(executable, args) {
  if (isDryRun) {
    console.log(`[DRY-RUN] ${executable} ${args.join(' ')}`);
    return;
  }
  try {
    execFileSync(executable, args, { stdio: 'pipe', windowsHide: true });
  } catch (error) {
    console.warn(`Could not remove the login item (it may not exist): ${error.message}`);
  }
}

function teardownEngine() {
  if (isDryRun) {
    console.log('[DRY-RUN] Run CatBee --factory-reset and wait for verified engine teardown.');
    return;
  }
  const entrypoint = path.join(root, 'dist', 'main', 'main.js');
  if (!fs.existsSync(entrypoint)) {
    throw new Error('Build the application first with "npm run build".');
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Reuse the platform drivers instead of killing unrelated Electron apps or deleting live VM disks.
  execFileSync(require('electron'), [entrypoint, '--factory-reset'], { env, stdio: 'inherit', windowsHide: true });
}

function removeApplicationData() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    remove(path.join(appData, 'CatBee Container Studio'));
    remove(path.join(appData, 'catbee-container-studio'));
    remove(path.join(localAppData, 'catbee-container-studio-updater'));
    for (const name of ['CatBee Container Studio', 'catbee-container-studio']) {
      removeLoginItem('reg.exe', [
        'delete',
        String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
        '/v',
        name,
        '/f'
      ]);
    }
  } else if (process.platform === 'darwin') {
    remove(path.join(home, 'Library', 'Application Support', 'CatBee Container Studio'));
    remove(path.join(home, 'Library', 'Application Support', 'catbee-container-studio'));
    remove(path.join(home, 'Library', 'Logs', 'CatBee Container Studio'));
    remove(path.join(home, 'Library', 'Caches', 'catbee-container-studio-updater'));
    remove(path.join(home, 'Library', 'Preferences', 'in.catbee.container.studio.plist'));
    removeLoginItem('osascript', [
      '-e',
      'tell application "System Events" to delete login item "CatBee Container Studio"'
    ]);
  } else if (process.platform === 'linux') {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    const cacheHome = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
    remove(path.join(configHome, 'CatBee Container Studio'));
    remove(path.join(configHome, 'catbee-container-studio'));
    remove(path.join(cacheHome, 'catbee-container-studio'));
    remove(path.join(cacheHome, 'catbee-container-studio-updater'));
    remove(path.join(configHome, 'autostart', 'catbee-container-studio.desktop'));
  } else {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

console.log(`CatBee Container Studio environment reset (${process.platform})`);
console.log('Close all installed and development instances of CatBee before continuing.');
console.log(
  isDryRun
    ? 'DRY RUN: no commands will be executed and no data will be removed.'
    : 'This permanently removes the built-in engine, its containers and volumes, and application settings.'
);

try {
  if (!skipDelay) {
    console.log('Starting in 5 seconds. Press Ctrl+C to cancel.');
    await sleep(5000);
  }
  started = true;
  teardownEngine();
  removeApplicationData();
  console.log(isDryRun ? 'Dry run complete.' : 'Reset complete.');
} catch (error) {
  console.error(`Reset failed: ${error.message}`);
  console.error('Remaining application data has been preserved. Resolve the error before retrying.');
  process.exitCode = 1;
}
