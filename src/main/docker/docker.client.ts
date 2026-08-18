import Docker from 'dockerode';
import { resolveDockerConnection, type ResolvedDockerConnection } from './docker.connection';
import { logger } from '../logger';

export async function createDockerClient(connection?: ResolvedDockerConnection): Promise<Docker> {
  const resolvedConnection = connection ?? (await resolveDockerConnection());
  return createDockerInstance(resolvedConnection);
}

function createDockerInstance(connection: ResolvedDockerConnection): Docker {
  logger.info({ connection }, `[DockerConnection], Creating Docker client with connection`);
  switch (connection.type) {
    case 'unix':
    case 'npipe':
      return new Docker({
        socketPath: connection.path
      });

    case 'tcp':
      return new Docker({
        host: connection.host,
        port: connection.port
      });
  }
}
