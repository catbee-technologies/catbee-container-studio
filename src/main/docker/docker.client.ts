import Docker from 'dockerode';
import type { DockerConnection } from './types/connection.types';
import { logger as appLogger } from '../logger';

const logger = appLogger.child({}, { msgPrefix: '[DockerClient] ' });

export function createDockerClient(connection: DockerConnection): Docker {
  logger.debug({ connection }, 'Creating Docker client instance.');

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
