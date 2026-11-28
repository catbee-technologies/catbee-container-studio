import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type Docker from 'dockerode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerContainerService } from '../../../../src/main/docker/services/docker.container.service';

vi.mock('electron', () => ({}));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../../../src/main/docker/runtime/docker.runtime', () => ({ getDockerCliPath: async () => 'docker' }));

type Exec = (
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
) => void;

const command = vi.mocked(execFile as unknown as Exec);

describe('Compose recreation', () => {
  const service = new DockerContainerService({} as Docker, { type: 'tcp', host: '127.0.0.1', port: 23750 });

  beforeEach(() => command.mockReset());
  afterEach(() => vi.unstubAllEnvs());

  it('pins both CLI paths to the selected Docker engine', async () => {
    vi.stubEnv('DOCKER_HOST', 'tcp://other-host:2375');
    vi.stubEnv('DOCKER_CONTEXT', 'other-engine');
    vi.stubEnv('DOCKER_TLS_VERIFY', '1');
    command
      .mockImplementationOnce((_binary, _args, _options, callback) =>
        callback(new Error('unknown command: docker compose'))
      )
      .mockImplementationOnce((_binary, _args, _options, callback) =>
        callback(null, { stdout: 'recreated', stderr: '' })
      );

    const workingDir = path.join(os.tmpdir(), 'release..candidate');
    await service.recreateComposeGroup({ workingDir });

    expect(command.mock.calls.map(([binary, args]) => [binary, ...args])).toEqual([
      ['docker', 'compose', 'up', '-d', '--force-recreate'],
      ['docker-compose', 'up', '-d', '--force-recreate']
    ]);
    for (const [, , { cwd, env }] of command.mock.calls) {
      expect(cwd).toBe(workingDir);
      expect(env['DOCKER_HOST']).toBe('tcp://127.0.0.1:23750');
      expect(env['DOCKER_CONTEXT']).toBeUndefined();
      expect(env['DOCKER_TLS_VERIFY']).toBeUndefined();
    }
  });

  it('rejects actual traversal before launching Docker', async () => {
    const workingDir = `${os.tmpdir()}${path.sep}..${path.sep}compose`;
    await expect(service.recreateComposeGroup({ workingDir })).rejects.toThrow('without traversal');
    expect(command).not.toHaveBeenCalled();
  });
});
