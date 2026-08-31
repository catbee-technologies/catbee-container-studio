export type DockerConnection = DockerUnixConnection | DockerNpipeConnection | DockerTcpConnection;

export type DockerUnixConnection = {
  type: 'unix';
  path: string;
};

export type DockerNpipeConnection = {
  type: 'npipe';
  path: string;
};

export type DockerTcpConnection = {
  type: 'tcp';
  host: string;
  port: number;
};

export type DockerConnectionSource = 'docker-host' | 'docker-context' | 'platform-default';

export type ResolvedDockerConnection = DockerConnection & {
  source: DockerConnectionSource;
};

export type DockerContextInspect = {
  Endpoints?: {
    docker?: {
      Host?: string;
    };
  };
};
