export type DockerRuntime = 'docker-desktop' | 'rancher-desktop';

export interface DockerRuntimeInfo {
  runtime: DockerRuntime;
  executablePath: string;
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
      state: 'starting-runtime';
      runtime: DockerRuntime;
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
