import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATBEE_K8S_CLUSTER_NAME,
  KIND_CLOUD_PROVIDER_CONTAINER,
  KIND_CLOUD_PROVIDER_IMAGE
} from '../../../src/constants.docker';
import { DEFAULT_ENGINE_SETTINGS, getEngineSettings } from '../../../src/main/docker/embedded/engine-settings';
import { pingDockerEndpoint, runCommand } from '../../../src/main/docker/embedded/engine-utils';
import { dockerManager } from '../../../src/main/docker/services/docker.manager';
import { k8sManager } from '../../../src/main/k8s/k8s-manager';

vi.mock('electron', () => ({}));
const { home, request } = vi.hoisted(() => ({ home: vi.fn(), request: vi.fn() }));
vi.mock('node:https', () => ({ get: request }));
// Match the CommonJS default import produced by the Electron build.
vi.mock('js-yaml', async importOriginal => {
  const yaml = await importOriginal<typeof import('js-yaml')>();
  return { default: yaml };
});
vi.mock('../../../src/main/docker/embedded/engine-paths', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/main/docker/embedded/engine-paths')>()),
  homeDir: home
}));
vi.mock('../../../src/main/docker/embedded/engine-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/main/docker/embedded/engine-utils')>()),
  pingDockerEndpoint: vi.fn(),
  runCommand: vi.fn()
}));
vi.mock('../../../src/main/docker/embedded/engine-settings', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/main/docker/embedded/engine-settings')>()),
  getEngineSettings: vi.fn()
}));
vi.mock('../../../src/main/docker/runtime/docker.runtime', () => ({ getDockerCliPath: async () => null }));
vi.mock('../../../src/main/docker/services/docker.manager', () => ({
  dockerManager: {
    currentRuntime: { source: 'embedded', connection: { type: 'unix', path: '/var/run/docker.sock' } },
    isEmbeddedEngineReady: true,
    containers: {
      listContainers: vi.fn(),
      inspectContainer: vi.fn(),
      createContainer: vi.fn(),
      startContainer: vi.fn(),
      stopContainer: vi.fn(),
      unpauseContainer: vi.fn(),
      removeContainer: vi.fn()
    },
    images: { listImages: vi.fn(), pullImage: vi.fn() },
    networks: { listNetworks: vi.fn(), createNetwork: vi.fn() }
  }
}));

const containers = dockerManager.containers;
const list = vi.mocked(containers.listContainers);
type Container = Awaited<ReturnType<typeof containers.listContainers>>[number];

function node(id: string, state: string, cluster = CATBEE_K8S_CLUSTER_NAME): Container {
  return {
    Id: id,
    State: state,
    Labels: { 'io.x-k8s.kind.cluster': cluster, 'io.x-k8s.kind.role': 'control-plane' }
  } as unknown as Container;
}

describe('Kubernetes lifecycle', () => {
  let directory: string;
  let kubeconfig: string;
  const runtime = dockerManager.currentRuntime;

  async function exportKindKubeconfig(): Promise<void> {
    const context = `kind-${CATBEE_K8S_CLUSTER_NAME}`;
    await writeFile(
      kubeconfig,
      JSON.stringify({
        contexts: [{ name: context, context: { cluster: context, user: context } }],
        clusters: [
          { name: context, cluster: { server: 'https://127.0.0.1:6443', 'certificate-authority-data': 'Y2E=' } }
        ],
        users: [{ name: context, user: { 'client-certificate-data': 'Y2VydA==', 'client-key-data': 'a2V5' } }]
      })
    );
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }));
    directory = await mkdtemp(path.join(tmpdir(), 'catbee-kind-test-'));
    kubeconfig = path.join(directory, 'config');
    home.mockReturnValue(directory);
    vi.stubEnv('KUBECONFIG', kubeconfig);
    vi.mocked(getEngineSettings).mockResolvedValue(DEFAULT_ENGINE_SETTINGS);
    vi.mocked(pingDockerEndpoint).mockResolvedValue(true);
    vi.spyOn(k8sManager, 'getKindBinaryPath').mockResolvedValue('kind');
    vi.spyOn(k8sManager, 'isKindInstalled').mockResolvedValue(true);
  });

  afterEach(async () => {
    Object.assign(dockerManager, { currentRuntime: runtime, containers, isEmbeddedEngineReady: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it('stops only CatBee nodes, unpauses paused nodes first, and keeps their volumes and kubeconfig', async () => {
    list.mockResolvedValue([
      node('active', 'running'),
      node('paused', 'paused'),
      node('retained', 'exited'),
      node('external', 'running', 'unrelated')
    ]);
    const cleanup = vi.spyOn(k8sManager, 'cleanKubeconfig').mockResolvedValue(undefined);

    await k8sManager.stopCluster();

    expect(containers.stopContainer).toHaveBeenCalledTimes(2);
    expect(containers.stopContainer).toHaveBeenNthCalledWith(1, 'active');
    expect(containers.stopContainer).toHaveBeenNthCalledWith(2, 'paused');
    expect(containers.unpauseContainer).toHaveBeenCalledExactlyOnceWith('paused');
    expect(vi.mocked(containers.unpauseContainer).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(containers.stopContainer).mock.invocationCallOrder[1]
    );
    expect(containers.removeContainer).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('removes the node volumes and kubeconfig for explicit cluster removal', async () => {
    list.mockResolvedValue([node('retained', 'exited')]);
    const cleanup = vi.spyOn(k8sManager, 'cleanKubeconfig').mockResolvedValue(undefined);
    await k8sManager.removeCluster();
    expect(containers.removeContainer).toHaveBeenCalledExactlyOnceWith('retained', true, true);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('waits for engine operations to resume before applying the disabled setting', async () => {
    const resume = await k8sManager.suspendOperations();
    list.mockResolvedValue([node('active', 'running')]);
    const apply = k8sManager.applyEnabledSetting();
    try {
      await Promise.resolve();
      expect(getEngineSettings).not.toHaveBeenCalled();
    } finally {
      resume();
    }
    await apply;
    expect(containers.stopContainer).toHaveBeenCalledExactlyOnceWith('active');
  });

  it('reports a running control plane as unavailable when kubeconfig is missing', async () => {
    vi.spyOn(k8sManager, 'isKindInstalled').mockResolvedValue(true);
    vi.stubEnv('KUBECONFIG', path.join(tmpdir(), `catbee-missing-${randomUUID()}`, 'config'));
    list.mockResolvedValue([node('control-plane', 'running')]);
    await expect(k8sManager.getStatus()).resolves.toMatchObject({
      status: 'error',
      error: 'Could not read the CatBee kubeconfig.'
    });
  });

  it.each(['external', 'stopped'])('blocks operations when the selected engine is %s', async condition => {
    Object.assign(dockerManager, {
      currentRuntime: condition === 'external' ? { ...runtime, source: 'external' } : runtime,
      isEmbeddedEngineReady: false
    });
    await expect(k8sManager.installKind()).rejects.toThrow('Start and connect to the CatBee built-in engine');
    await expect(k8sManager.startCluster()).rejects.toThrow('Start and connect to the CatBee built-in engine');
    await expect(k8sManager.getStatus()).resolves.toMatchObject({ status: 'unavailable', isKindInstalled: true });
    expect(runCommand).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('does not run kind when the built-in engine no longer answers its readiness probe', async () => {
    vi.mocked(pingDockerEndpoint).mockResolvedValue(false);
    await expect(k8sManager.checkEngineAvailable()).rejects.toThrow('Start and connect to the CatBee built-in engine');
    await expect(k8sManager.installKind()).rejects.toThrow('Start and connect to the CatBee built-in engine');
    await expect(k8sManager.getStatus()).resolves.toMatchObject({ status: 'unavailable', isKindInstalled: true });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'linux'])('reports a missing host kind binary with the engine stopped on %s', async platform => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: platform } }));
    Object.assign(dockerManager, { isEmbeddedEngineReady: false });
    vi.mocked(k8sManager.getKindBinaryPath).mockResolvedValue(null);

    await expect(k8sManager.getStatus()).resolves.toMatchObject({ status: 'unavailable', isKindInstalled: false });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('keeps creation and kubeconfig export on the original runtime through a context change', async () => {
    const readinessStarted = Promise.withResolvers<void>();
    const commands = vi.mocked(runCommand).mockImplementation(async (_bin, args) => {
      if (args[0] === 'create') {
        Object.assign(dockerManager, {
          currentRuntime: { ...runtime, connection: { type: 'tcp', host: 'other.test', port: 2375 } }
        });
      } else {
        await exportKindKubeconfig();
      }
      return { stdout: '', stderr: '' };
    });
    list.mockResolvedValue([]);
    request.mockImplementation((_url, options: { signal: AbortSignal }) => {
      const pending = new EventEmitter();
      options.signal.addEventListener('abort', () => pending.emit('error', new Error('aborted')), { once: true });
      readinessStarted.resolve();
      return pending;
    });
    const start = k8sManager.startCluster();
    await Promise.race([readinessStarted.promise, start]);
    expect(commands.mock.calls.map(([, args, options]) => [args.slice(0, 2), options?.env?.['DOCKER_HOST']])).toEqual([
      [['create', 'cluster'], 'unix:///var/run/docker.sock'],
      [['export', 'kubeconfig'], 'unix:///var/run/docker.sock']
    ]);
    const resume = await k8sManager.suspendOperations();
    try {
      await expect(start).resolves.toEqual({ success: false, cancelled: true });
      expect(containers.removeContainer).not.toHaveBeenCalled();
    } finally {
      resume();
    }
  });

  it('cleans up a cancelled create on the engine that started the cluster', async () => {
    const creating = Promise.withResolvers<void>();
    const otherEngineRemove = vi.fn();
    list.mockResolvedValueOnce([]).mockResolvedValue([node('original-node', 'running')]);
    vi.mocked(runCommand).mockImplementation(async (_bin, _args, options) => {
      creating.resolve();
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return { stdout: '', stderr: '' };
    });
    const start = k8sManager.startCluster();
    await Promise.race([creating.promise, start]);
    Object.assign(dockerManager, { containers: { ...containers, removeContainer: otherEngineRemove } });
    await expect(k8sManager.cancelCurrentOperation()).resolves.toEqual({ success: true });
    await expect(start).resolves.toEqual({ success: false, cancelled: true });
    expect(containers.removeContainer).toHaveBeenCalledExactlyOnceWith('original-node', true, true);
    expect(otherEngineRemove).not.toHaveBeenCalled();
  });

  it('fails when a retained cluster cannot export kubeconfig', async () => {
    list.mockResolvedValue([node('retained', 'running')]);
    vi.mocked(runCommand).mockRejectedValue(new Error('kind export failed'));
    await expect(k8sManager.startCluster()).rejects.toThrow('Could not export the Kubernetes kubeconfig');
    expect(request).not.toHaveBeenCalled();
    expect(containers.removeContainer).not.toHaveBeenCalled();
  });

  it('uses the control plane’s network and cleans up a failed optional cloud provider', async () => {
    const controlPlane = node('control-plane', 'running');
    controlPlane.NetworkSettings = { Networks: { custom: {} as Container['NetworkSettings']['Networks'][string] } };
    list.mockResolvedValue([controlPlane]);
    vi.mocked(runCommand).mockImplementation(async () => {
      await exportKindKubeconfig();
      return { stdout: '', stderr: '' };
    });
    request.mockImplementation((_url, _options, callback) => {
      callback({ statusCode: 200, resume: vi.fn() });
      return new EventEmitter();
    });
    vi.mocked(dockerManager.images.listImages).mockResolvedValue([
      { RepoTags: [KIND_CLOUD_PROVIDER_IMAGE.replace(/^docker\.io\//, '')] } as Awaited<
        ReturnType<typeof dockerManager.images.listImages>
      >[number]
    ]);
    vi.mocked(dockerManager.networks.listNetworks).mockResolvedValue([]);
    vi.mocked(containers.createContainer).mockResolvedValue({
      Id: 'companion'
    } as Awaited<ReturnType<typeof containers.createContainer>>);
    vi.mocked(containers.startContainer).mockRejectedValue(new Error('companion did not start'));

    await expect(k8sManager.startCluster()).resolves.toEqual({ success: true });
    expect(dockerManager.networks.createNetwork).toHaveBeenCalledWith({ Name: 'custom', Driver: 'bridge' });
    expect(dockerManager.images.pullImage).not.toHaveBeenCalled();
    expect(containers.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: KIND_CLOUD_PROVIDER_CONTAINER,
        HostConfig: expect.objectContaining({ NetworkMode: 'custom' })
      })
    );
    expect(containers.startContainer).toHaveBeenCalledExactlyOnceWith('companion');
    expect(containers.removeContainer).toHaveBeenCalledExactlyOnceWith('companion', true);
  });

  it.each([
    ['unowned', {}, 'degraded'],
    [
      'legacy',
      { 'io.x-k8s.kind.cluster': CATBEE_K8S_CLUSTER_NAME, 'io.kubernetes.pod.namespace': 'kube-system' },
      'running'
    ]
  ])('reports API readiness separately from a %s cloud-provider container', async (id, labels, status) => {
    await exportKindKubeconfig();
    const controlPlane = node('control-plane', 'running');
    controlPlane.Ports = [{ IP: '127.0.0.1', PrivatePort: 6443, PublicPort: 6443, Type: 'tcp' }];
    list.mockResolvedValue([
      controlPlane,
      { ...node(id, 'running'), Names: ['/kind-cloud-provider'], Labels: labels as Record<string, string> }
    ]);
    request.mockImplementation((_url, _options, callback) => {
      callback({ statusCode: 200, resume: vi.fn() });
      return new EventEmitter();
    });

    const result = await k8sManager.getStatus();
    expect(result.status).toBe(status);
    if (status === 'degraded') expect(result.warning).toContain('LoadBalancer');
    else expect(result.warning).toBeUndefined();
    expect(containers.removeContainer).not.toHaveBeenCalled();
  });
});
