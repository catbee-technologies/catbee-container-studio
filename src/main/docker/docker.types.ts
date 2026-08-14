export interface DockerActionResult {
  containerId: string;
  output: string;
}

export interface DockerProgressEvent {
  status?: string;
  id?: string;
  progress?: string;
  stream?: string;
  error?: string;
}

export interface DockerContainerPort {
  containerPort: string;
  hostBindings: Array<{
    hostIp: string;
    hostPort: string;
  }>;
}

export interface DockerContainerMount {
  type: string;
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
  propagation: string;
}

export interface DockerContainerNetwork {
  name: string;
  networkId: string;
  endpointId: string;
  gateway: string;
  ipAddress: string;
  ipPrefixLen: number;
  macAddress: string;
  aliases: string[];
}

export interface DockerSystemPruneSummary {
  containers: unknown;
  images: unknown;
  volumes: unknown;
  networks: unknown;
  buildCache: unknown;
}
