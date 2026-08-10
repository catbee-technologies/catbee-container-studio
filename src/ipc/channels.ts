export const IPC_CHANNELS = {
  Docker: {
    ListContainers: 'docker:list-containers',
    StartContainer: 'docker:start-container',
    StopContainer: 'docker:stop-container'
  }
} as const;
