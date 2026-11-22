#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const platform = process.platform;
const isDryRun = process.argv.includes('--dry-run');
const skipDelay = isDryRun || process.argv.includes('-f') || process.argv.includes('--force');

process.on('SIGINT', () => {
  console.log('\n\n🛑 Reset cancelled by user. No changes were made.\n');
  process.exit(130);
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑 Reset terminated. Exiting.\n');
  process.exit(143);
});

console.log('='.repeat(70));
console.log(`🧹 CatBee Container Studio - Full Environment Reset Tool [${platform}]`);
console.log('='.repeat(70));

if (isDryRun) {
  console.log('🔍 Running in DRY-RUN mode (no files or distros will be deleted).\n');
} else {
  console.log('⚠️  This will completely uninstall the built-in engine, wipe app settings,');
  console.log('   delete daemon.json, and reset Docker contexts for a fresh first launch.\n');
}

function run(cmd, ignoreError = true) {
  try {
    if (isDryRun) {
      console.log(`   [DRY-RUN] ${cmd}`);
      return '';
    }
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim();
  } catch (err) {
    if (!ignoreError) throw err;
    return '';
  }
}

function removeDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return;
  if (isDryRun) {
    console.log(`   [DRY-RUN] Directory to remove: ${dirPath}`);
    return;
  }
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    console.log(`   ✓ Deleted directory: ${dirPath}`);
  } catch (err) {
    console.warn(`   ⚠️  Failed to delete ${dirPath}: ${err.message}`);
  }
}

function removeFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  if (isDryRun) {
    console.log(`   [DRY-RUN] File to remove: ${filePath}`);
    return;
  }
  try {
    fs.unlinkSync(filePath);
    console.log(`   ✓ Deleted file: ${filePath}`);
  } catch (err) {
    console.warn(`   ⚠️  Failed to delete ${filePath}: ${err.message}`);
  }
}

function resetWindows() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

  console.log('1. Stopping running CatBee and Electron processes...');
  run('taskkill /F /IM "catbee-container-studio.exe" 2>nul');
  run('taskkill /F /IM "CatBee Container Studio.exe" 2>nul');
  run('taskkill /F /IM "electron.exe" 2>nul');

  console.log('2. Resetting Docker CLI context...');
  run('docker context use default 2>nul');
  run('docker context rm -f catbee-desktop 2>nul');

  console.log('3. Unregistering CatBee WSL distribution and all its data...');
  const distros = run('wsl -l -q 2>nul') || '';
  if (distros.includes('catbee-container-engine')) {
    console.log('   Unregistering WSL distro: catbee-container-engine...');
    run('wsl --unregister catbee-container-engine 2>nul');
    console.log('   ✓ catbee-container-engine unregistered and wiped.');
  } else {
    console.log('   (catbee-container-engine is not registered)');
  }

  console.log('4. Removing WSL distro integration scripts from other distros...');
  const allDistros = distros
    .split(/\r?\n/)
    .map(d => d.replaceAll('\0', '').trim())
    .filter(Boolean);
  for (const d of allDistros) {
    if (!/catbee|docker-desktop/i.test(d)) {
      run(`wsl -d "${d}" -u root rm -f /etc/profile.d/catbee-docker.sh 2>nul`);
    }
  }

  console.log('5. Deleting built-in engine files, logs, settings & downloads...');
  removeDir(path.join(localAppData, 'CatBee'));

  console.log('6. Deleting Electron application data, localStorage & caches...');
  removeDir(path.join(appData, 'CatBee Container Studio'));
  removeDir(path.join(appData, 'catbee-container-studio'));
  removeDir(path.join(localAppData, 'catbee-container-studio-updater'));

  console.log('7. Removing startup registry entries if configured...');
  run(
    String.raw`reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "CatBee Container Studio" /f 2>nul`
  );
  run(
    String.raw`reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "catbee-container-studio" /f 2>nul`
  );
}

function resetMacOS() {
  const home = os.homedir();

  console.log('1. Stopping running CatBee processes...');
  run('killall "CatBee Container Studio" 2>/dev/null || true');
  run('killall "catbee-container-studio" 2>/dev/null || true');
  run('killall "Electron" 2>/dev/null || true');

  console.log('2. Resetting Docker CLI context...');
  run('docker context use default 2>/dev/null || true');
  run('docker context rm -f catbee-desktop 2>/dev/null || true');

  console.log('3. Deleting CatBee Lima VM instance...');
  const limactlPath =
    [
      path.join(home, 'Library/Application Support/CatBee/engine/bin/limactl'),
      '/opt/homebrew/bin/limactl',
      '/usr/local/bin/limactl'
    ].find(p => fs.existsSync(p)) || 'limactl';

  run(`LIMA_HOME="${path.join(home, '.catbee/lima')}" "${limactlPath}" stop --force catbee 2>/dev/null || true`);
  run(`LIMA_HOME="${path.join(home, '.catbee/lima')}" "${limactlPath}" delete --force catbee 2>/dev/null || true`);

  console.log('4. Deleting engine files, Lima home & runtime sockets...');
  removeDir(path.join(home, '.catbee'));
  removeDir(path.join(home, 'Library/Application Support/CatBee'));
  removeDir(path.join(home, '.config/catbee'));

  console.log('5. Deleting Electron application data, settings & caches...');
  removeDir(path.join(home, 'Library/Application Support/CatBee Container Studio'));
  removeDir(path.join(home, 'Library/Application Support/catbee-container-studio'));
  removeDir(path.join(home, 'Library/Logs/CatBee Container Studio'));
  removeDir(path.join(home, 'Library/Caches/catbee-container-studio-updater'));
  removeFile(path.join(home, 'Library/Preferences/in.catbee.container.studio.plist'));

  console.log('6. Removing login item if present...');
  run(
    `osascript -e 'tell application "System Events" to delete login item "CatBee Container Studio"' 2>/dev/null || true`
  );
}

function resetLinux() {
  const home = os.homedir();
  const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local/share');
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const xdgRuntime = process.env.XDG_RUNTIME_DIR || path.join(home, '.catbee/run');

  console.log('1. Stopping running processes & rootless daemon...');
  run('pkill -f "rootlesskit.*catbee" 2>/dev/null || true');
  run('pkill -f "dockerd.*catbee" 2>/dev/null || true');
  run('pkill -f "catbee-container-studio" 2>/dev/null || true');

  console.log('2. Resetting Docker CLI context...');
  run('docker context use default 2>/dev/null || true');
  run('docker context rm -f catbee-desktop 2>/dev/null || true');

  console.log('3. Deleting engine files, daemon.json & rootless data...');
  removeDir(path.join(xdgData, 'catbee'));
  removeDir(path.join(home, '.catbee'));
  removeDir(path.join(xdgConfig, 'catbee'));
  if (xdgRuntime.includes('catbee')) {
    removeDir(xdgRuntime);
  } else {
    removeDir(path.join(xdgRuntime, 'catbee'));
  }

  console.log('4. Deleting Electron application data & caches...');
  removeDir(path.join(xdgConfig, 'CatBee Container Studio'));
  removeDir(path.join(xdgConfig, 'catbee-container-studio'));
  removeDir(path.join(home, '.cache/catbee-container-studio'));
  removeDir(path.join(home, '.cache/catbee-container-studio-updater'));

  console.log('5. Removing autostart entry if present...');
  removeFile(path.join(xdgConfig, 'autostart/catbee-container-studio.desktop'));
}

async function delayCountdown(seconds = 5) {
  if (skipDelay) return;

  const cancelKey = platform === 'darwin' ? 'Control+C' : 'Ctrl+C';
  console.log(`⏳ Starting full environment reset in ${seconds} seconds... Press ${cancelKey} to cancel.\n`);
  for (let i = seconds; i > 0; i--) {
    if (process.stdout.isTTY) {
      process.stdout.write(`   Starting in ${i}s... Press ${cancelKey} to abort\r`);
    } else {
      console.log(`   Starting in ${i}s...`);
    }
    await sleep(1000);
  }
  if (process.stdout.isTTY) {
    process.stdout.write('   Starting now...                                  \r\n\n');
  } else {
    console.log('   Starting now...\n');
  }
}

await delayCountdown(5);

switch (platform) {
  case 'win32':
    resetWindows();
    break;
  case 'darwin':
    resetMacOS();
    break;
  default:
    resetLinux();
    break;
}

console.log('\n' + '='.repeat(70));
console.log('✨ Reset complete! You now have a clean, fresh-install environment.');
console.log('   When you launch the packaged app, it will behave as a brand new installation.');
console.log('='.repeat(70) + '\n');
