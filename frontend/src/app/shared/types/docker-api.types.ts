export interface IpcErrorPayload {
  message: string;
  code?: string;
  details?: unknown;
}

export interface IpcSuccess<T> {
  ok: true;
  data: T;
}

export interface IpcFailure {
  ok: false;
  error: IpcErrorPayload;
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

export type DockerStreamKind = 'logs' | 'stats' | 'events' | 'pull' | 'push' | 'exec';
export type DockerStreamEventType = 'data' | 'error' | 'end';
export type DockerLogChannel = 'stdout' | 'stderr';

export interface DockerStreamEventEnvelope<T = unknown> {
  streamId: string;
  kind: DockerStreamKind;
  type: DockerStreamEventType;
  timestamp: string;
  channel?: DockerLogChannel;
  data?: T;
  error?: string;
}

export interface DockerActionResult {
  containerId: string;
  output: string;
}

export interface DockerContainerInfo {
  Id: string;
  Names: string[];
  Image: string;
  ImageID?: string;
  Command: string;
  Created: number;
  State: string;
  Status: string;
  Labels: Record<string, string>;
  Ports: DockerPortInfo[];
}

export interface DockerContainerInspectMount {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
  Mode?: string;
  RW?: boolean;
  Propagation?: string;
}

export interface DockerContainerInspectInfo {
  Id?: string;
  Image?: string;
  ImageID?: string;
  Name?: string;
  Created?: string;
  Author?: string;
  Architecture?: string;
  Os?: string;
  RootFS?: {
    Layers?: string[];
  };
  Config?: {
    Cmd?: string[];
    Entrypoint?: string[];
    Env?: string[];
    Volumes?: Record<string, unknown>;
  };
  HostConfig?: {
    Binds?: string[];
  };
  Mounts?: DockerContainerInspectMount[];
  State?: {
    Status?: string;
    Running?: boolean;
    Paused?: boolean;
  };
}

export interface DockerPortInfo {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

export interface DockerContainerStats {
  id?: string;
  name?: string;
  read: string;
  preread: string;
  cpu_stats: {
    cpu_usage: {
      total_usage: number;
      percpu_usage?: number[];
    };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats: {
    cpu_usage: {
      total_usage: number;
    };
    system_cpu_usage?: number;
  };
  memory_stats: {
    usage?: number;
    limit?: number;
  };
  networks?: Record<
    string,
    {
      rx_bytes?: number;
      tx_bytes?: number;
    }
  >;
  blkio_stats?: {
    io_service_bytes_recursive?: {
      op?: string;
      value?: number;
    }[];
  };
}

export interface StreamStartResult {
  streamId: string;
}

export interface DockerImageInfo {
  Id: string;
  RepoTags: string[] | null;
  RepoDigests: string[] | null;
  Size: number;
  SharedSize: number;
  VirtualSize?: number;
  Labels: Record<string, string> | null;
  Containers: number;
  Created: number;
  ParentId: string;
}

export interface DockerImageHistoryInfo {
  Id: string;
  Created: number;
  CreatedBy: string;
  Tags?: string[];
  Size: number;
  Comment: string;
}

export interface DockerImageInspectInfo {
  Id?: string;
  RepoTags?: string[];
  RepoDigests?: string[];
  Created?: string;
  Author?: string;
  Architecture?: string;
  Os?: string;
  Size?: number;
  RootFS?: {
    Layers?: string[];
  };
  Config?: {
    Cmd?: string[];
    Entrypoint?: string[];
  };
}

export interface DockerVolumeInfo {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Scope: string;
  Labels: Record<string, string> | null;
  Options: Record<string, string> | null;
  CreatedAt?: string;
  UsageData?: { Size: number; RefCount: number } | null;
}

export interface DockerExecSessionCreateResult {
  sessionId: string;
  execId: string;
}
