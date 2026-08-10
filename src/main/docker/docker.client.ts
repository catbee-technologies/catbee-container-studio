import Docker from 'dockerode';

export function createDockerClient(): Docker {
  return new Docker();
}
