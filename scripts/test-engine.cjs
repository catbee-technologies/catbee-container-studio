const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdtemp, readdir, readFile, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { app } = require('electron');

async function testEngine() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run this test on a disposable GitHub Actions runner.');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'This test requires a clean GitHub-hosted runner.');

  const { CATBEE_CONTEXT_NAME } = require('../dist/constants.docker.js');
  const { dockerCliEnv } = require('../dist/main/docker/docker.connection.js');
  const { engineManager } = require('../dist/main/docker/embedded/engine.manager.js');
  const {
    getEngineBinDir,
    getEngineDownloadsDir,
    homeDir,
    SHELL_PROFILE_TARGETS
  } = require('../dist/main/docker/embedded/engine-paths.js');
  const {
    DEFAULT_ENGINE_SETTINGS,
    getEngineSettings,
    saveEngineSettings
  } = require('../dist/main/docker/embedded/engine-settings.js');
  const {
    connectionToUri,
    ensureHostDockerCli,
    pathExists,
    pingDockerEndpoint,
    runCommand
  } = require('../dist/main/docker/embedded/engine-utils.js');
  const { dockerManager } = require('../dist/main/docker/services/docker.manager.js');

  const windows = process.platform === 'win32';
  const macos = process.platform === 'darwin';
  const cli = path.join(getEngineBinDir(), windows ? 'docker.exe' : 'docker');
  const expectedBackend = windows ? 'wsl2' : macos ? 'lima' : 'rootless';
  const context = ['--context', CATBEE_CONTEXT_NAME];
  const phase = process.env.CATBEE_TEST_PHASE ?? 'smoke';
  assert.ok(['smoke', 'seed', 'upgrade'].includes(phase));
  const upgrading = phase === 'upgrade';
  const image = 'docker.io/library/alpine:3.22';
  const mount = ['--mount', 'type=volume,source=catbee-ci-data,target=/data'];
  const marker = 'catbee-engine-ok';
  const bashProfile = path.join(homeDir(), '.bash_profile');
  const bashSetting = 'export CATBEE_TEST_CUSTOM_SETTING=preserved';
  const readWindowsUserPath = async () => {
    const { stdout } = await runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Environment]::GetEnvironmentVariable("Path", "User")'
    ]);
    return stdout.trim().toLowerCase().split(';');
  };
  const findDockerInPowerShell = async () => {
    const { stdout } = await runCommand('powershell.exe', [
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '(Get-Command docker -CommandType Application -ErrorAction SilentlyContinue).Source'
    ]);
    return stdout.trim().toLowerCase();
  };

  assert.equal(await engineManager.isInstalled(), upgrading, 'Unexpected engine state before the test.');
  assert.equal(await pathExists(cli), upgrading, 'Unexpected CLI state before the test.');

  let contextMetadataPath;
  let keepEngine = false;
  let controlDistroImported = false;
  const controlDistro = 'catbee-ci-control';
  const runWsl = (args, timeoutMs = 60_000) =>
    runCommand('wsl.exe', args, { env: { ...process.env, WSL_UTF8: '1' }, timeoutMs });
  const runControlDistro = args => runWsl(['-d', controlDistro, '-u', 'root', '--exec', ...args]);
  try {
    if (macos && !upgrading) {
      // Lima's own GitHub-hosted Intel tests use a single vCPU with the VZ backend.
      await saveEngineSettings({ resources: { ...DEFAULT_ENGINE_SETTINGS.resources, cpus: 1, memoryGb: 2 } });
      assert.equal(await pathExists(path.join(homeDir(), '.zshrc')), false);
      if (phase === 'smoke') {
        await writeFile(bashProfile, `${bashSetting}\n`, { flag: 'wx' });
      }
    }
    if (process.platform === 'linux') {
      assert.equal((await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8')).trim(), '1');
    }

    if (upgrading) {
      assert.equal(
        (await getEngineSettings()).resourceSaverTimeout,
        137,
        'The previous build’s setting should survive.'
      );
      await dockerManager.startEmbeddedEngine();
    } else {
      console.log(`Installing ${expectedBackend} engine`);
      await dockerManager.installEmbeddedEngine((progress, stage) => console.log(`${progress}% ${stage}`));
    }
    assert.equal((await engineManager.getManifest())?.backend, expectedBackend);
    assert.equal(dockerManager.isEmbeddedEngineReady, true, 'The built-in Docker runtime should be ready.');
    await ensureHostDockerCli();

    const connection = engineManager.activeConnection;
    assert.ok(connection, 'Expected a CatBee engine endpoint.');
    const runDocker = (args, timeoutMs = 30_000) => runCommand(cli, args, { env: dockerCliEnv(), timeoutMs });
    const checkPersistedData = async () => {
      const { stdout } = await runDocker([...context, 'run', '--rm', ...mount, image, 'cat', '/data/marker']);
      assert.equal(stdout.trim(), marker, 'The named volume must retain data across engine restarts.');
      await runDocker([...context, 'container', 'inspect', 'catbee-ci-writer']);
    };
    const { stdout: contextJson } = await runDocker([
      'context',
      'inspect',
      CATBEE_CONTEXT_NAME,
      '--format',
      '{{json .}}'
    ]);
    const installedContext = JSON.parse(contextJson);
    assert.equal(installedContext.Endpoints.docker.Host, connectionToUri(connection));
    contextMetadataPath = installedContext.Storage.MetadataPath;
    assert.ok(path.isAbsolute(contextMetadataPath), 'Expected the CatBee context to be stored on disk.');

    if (windows) {
      // This is a new shell using its normal profile. Its inherited PATH predates installation.
      assert.equal(await findDockerInPowerShell(), cli.toLowerCase());
      assert.ok((await readWindowsUserPath()).includes(getEngineBinDir().toLowerCase()));
      if (phase === 'smoke') {
        const downloads = getEngineDownloadsDir();
        const rootfs = (await readdir(downloads)).find(file => /^alpine-minirootfs-.*\.tar\.gz$/.test(file));
        assert.ok(rootfs, 'Expected the Alpine root filesystem downloaded during installation.');
        const location = await mkdtemp(path.join(tmpdir(), 'catbee-ci-wsl-'));
        await runWsl(['--import', controlDistro, location, path.join(downloads, rootfs), '--version', '2'], 180_000);
        controlDistroImported = true;
        await runControlDistro(['sh', '-c', 'echo preserved >/catbee-ci-marker']);
      }
    } else if (macos) {
      const { stdout } = await runCommand('/bin/zsh', ['-lic', 'command -v docker']);
      assert.equal(stdout.trim(), cli);
    }

    if (!upgrading) {
      await runDocker(
        [
          ...context,
          'run',
          '--name',
          'catbee-ci-writer',
          ...mount,
          image,
          'sh',
          '-c',
          'printf %s "$1" > /data/marker',
          'catbee-ci',
          marker
        ],
        180_000
      );
    }
    await checkPersistedData();
    if (phase === 'seed') await saveEngineSettings({ resourceSaverTimeout: 137 });
    await dockerManager.stopEmbeddedEngine();
    assert.equal(await pingDockerEndpoint(connection), false, 'The CatBee endpoint should stop responding.');
    if (phase === 'seed') {
      keepEngine = true;
      return;
    }
    if (process.platform === 'linux' && phase === 'smoke') {
      const profile = process.env.CATBEE_TEST_APPARMOR_PROFILE;
      assert.ok(profile, 'Expected the runner’s RootlessKit profile.');
      const original = await readFile(profile, 'utf8');
      const denyNamespace = original.replace('flags=(unconfined)', '').replace('  userns,', '  file,\n  deny userns,');
      assert.notEqual(denyNamespace, original);
      try {
        await runCommand('sudo', ['apparmor_parser', '-r'], { input: denyNamespace, timeoutMs: 15_000 });
        await assert.rejects(() => dockerManager.startEmbeddedEngine(), {
          message: /RootlessKit could not create a user namespace[\s\S]*Allow rootlesskit/
        });
      } finally {
        await runCommand('sudo', ['apparmor_parser', '-r', profile], { timeoutMs: 15_000 });
      }
    }
    await dockerManager.startEmbeddedEngine();
    assert.equal(dockerManager.isEmbeddedEngineReady, true, 'The built-in runtime should recover after a restart.');
    const { stdout: version } = await runDocker([...context, 'version', '--format', '{{.Server.Version}}']);
    assert.ok(version.trim(), 'The restarted CatBee engine should report its Docker version.');
    await checkPersistedData();
    if (windows) {
      const entries = await readWindowsUserPath();
      assert.equal(entries.filter(entry => entry === getEngineBinDir().toLowerCase()).length, 1);
    }
    if (upgrading && !windows) {
      let configuredProfiles = 0;
      for (const name of SHELL_PROFILE_TARGETS) {
        const profile = path.join(homeDir(), name);
        if (!(await pathExists(profile))) continue;
        const entries = (await readFile(profile, 'utf8')).split('\n').filter(line => line.includes('.catbee/bin'));
        assert.ok(entries.length <= 1, `The upgrade should not duplicate the PATH entry in ${name}.`);
        configuredProfiles += entries.length;
      }
      assert.ok(configuredProfiles > 0, 'The upgrade should retain the shell PATH configuration.');
    }
  } catch (error) {
    console.error('Engine test failed:', error);
    throw error;
  } finally {
    if (!keepEngine) {
      try {
        console.log('Tearing down the built-in engine');
        await dockerManager.factoryResetTeardown((progress, stage) => console.log(`${progress}% ${stage}`));
        assert.equal(await engineManager.isInstalled(), false, 'The engine should be removed.');
        assert.equal(await pathExists(cli), false, 'The CatBee CLI should be removed.');
        if (contextMetadataPath) {
          assert.equal(await pathExists(contextMetadataPath), false, 'The CatBee context should be removed.');
        }
        if (windows) {
          assert.ok(!(await readWindowsUserPath()).includes(getEngineBinDir().toLowerCase()));
        } else if (macos) {
          const profile = path.join(process.env.HOME, '.zshrc');
          assert.doesNotMatch(
            await readFile(profile, 'utf8').catch(error => {
              if (error.code === 'ENOENT') return '';
              throw error;
            }),
            /\.catbee\/bin/
          );
          if (phase === 'smoke') {
            const bashContent = await readFile(bashProfile, 'utf8');
            assert.ok(bashContent.includes(bashSetting));
            assert.doesNotMatch(bashContent, /\.catbee\/bin/);
          }
        }
        if (controlDistroImported) {
          const { stdout } = await runControlDistro(['cat', '/catbee-ci-marker']);
          assert.equal(stdout.trim(), 'preserved', 'The unrelated WSL distro should survive CatBee teardown.');
        }
      } finally {
        if (controlDistroImported) {
          await runWsl(['--unregister', controlDistro]);
        }
      }
    }
  }
}

app
  .whenReady()
  .then(testEngine)
  .then(
    () => app.quit(),
    error => {
      console.error(error);
      app.exit(1);
    }
  );
