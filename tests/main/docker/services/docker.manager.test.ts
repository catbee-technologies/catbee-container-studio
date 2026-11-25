import { rm } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { removeCatBeeContext } from '../../../../src/main/docker/context/docker-context.manager';
import { resetEngineSettings } from '../../../../src/main/docker/embedded/engine-settings';
import { engineManager } from '../../../../src/main/docker/embedded/engine.manager';
import { DockerManager } from '../../../../src/main/docker/services/docker.manager';
import { k8sManager } from '../../../../src/main/k8s/k8s-manager';

const { resume } = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock('electron', () => ({}));
vi.mock('node:fs/promises', () => ({ rm: vi.fn() }));
vi.mock('../../../../src/main/docker/context/docker-context.manager', () => ({ removeCatBeeContext: vi.fn() }));
vi.mock('../../../../src/main/docker/embedded/engine-settings', () => ({ resetEngineSettings: vi.fn() }));
vi.mock('../../../../src/main/docker/embedded/engine.manager', () => ({ engineManager: { uninstall: vi.fn() } }));
vi.mock('../../../../src/main/docker/embedded/engine-utils', () => ({
  removeShellPath: vi.fn(),
  waitForHostDockerCliInstall: vi.fn()
}));
vi.mock('../../../../src/main/docker/embedded/resource-saver.manager', () => ({
  resourceSaverManager: { stop: vi.fn() }
}));
vi.mock('../../../../src/main/docker/runtime/docker.runtime-manager', () => ({ DockerRuntimeManager: class {} }));
vi.mock('../../../../src/main/k8s/k8s-manager', () => ({
  k8sManager: { suspendOperations: vi.fn(async () => resume), removeCluster: vi.fn() }
}));
vi.mock('../../../../src/main/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn() } }));

it('preserves engine files after a teardown failure and allows a retry', async () => {
  vi.mocked(engineManager.uninstall).mockRejectedValueOnce(new Error('engine shutdown failed'));
  const manager = new DockerManager();
  const progress = vi.fn();
  await expect(manager.factoryResetTeardown(progress)).rejects.toThrow('engine shutdown failed');
  expect(rm).not.toHaveBeenCalled();
  expect(resetEngineSettings).not.toHaveBeenCalled();
  expect(removeCatBeeContext).not.toHaveBeenCalled();
  expect(resume).toHaveBeenCalledOnce();

  await manager.factoryResetTeardown(progress);
  expect(k8sManager.removeCluster).toHaveBeenCalledTimes(2);
  expect(engineManager.uninstall).toHaveBeenCalledTimes(2);
  expect(resetEngineSettings).toHaveBeenCalledOnce();
  expect(rm).toHaveBeenCalledTimes(3);
  expect(resume).toHaveBeenCalledTimes(2);
  expect(progress).toHaveBeenLastCalledWith(100, 'Teardown complete.');
});
