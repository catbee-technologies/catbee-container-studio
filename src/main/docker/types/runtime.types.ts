import type { DockerConnection } from './connection.types';

export type DockerRuntime = 'docker-desktop' | 'rancher-desktop' | 'catbee-embedded' | 'system';

export type DockerRuntimeSource = 'external' | 'embedded';

export interface DockerRuntimeInfo {
  runtime: DockerRuntime;
  executablePath: string;
}

export interface SelectedDockerRuntime {
  source: DockerRuntimeSource;
  runtimeName: string;
  connection: DockerConnection;
  runtimeInfo?: DockerRuntimeInfo;
}

export type DockerInitializationStatus =
  | {
      state: 'checking';
      message: string;
      hint: string;
    }
  | {
      state: 'detecting-runtime';
      message: string;
      hint: string;
    }
  | {
      state: 'engine-not-installed';
      message: string;
      hint: string;
      prerequisitesOk: boolean;
      reason?: string;
    }
  | {
      state: 'installing-engine';
      progress: number;
      stage: string;
      message: string;
      hint: string;
    }
  | {
      state: 'starting-runtime';
      runtime: string;
      message: string;
      hint: string;
    }
  | {
      state: 'waiting-for-engine';
      message: string;
      hint: string;
    }
  | {
      state: 'ready';
      message: string;
      hint: string;
    }
  | {
      state: 'error';
      message: string;
      hint: string;
    };
