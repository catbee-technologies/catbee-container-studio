import type Docker from 'dockerode';
import { IPC_CHANNELS } from '../channels';
import { registerHandle } from '../utils/ipc.utils';
import { dockerManager } from '../../main/docker/services/docker.manager';

export function registerDockerImageHandlers(): void {
  registerHandle(IPC_CHANNELS.Docker.Images.List, (options?: Docker.ListImagesOptions) =>
    dockerManager.images.listImages(options)
  );

  registerHandle(IPC_CHANNELS.Docker.Images.Inspect, (imageId: string) => dockerManager.images.inspectImage(imageId));

  registerHandle(IPC_CHANNELS.Docker.Images.Pull, (image: string, options?: {}) =>
    dockerManager.images.pullImage(image, options)
  );

  registerHandle(IPC_CHANNELS.Docker.Images.Push, (repoTag: string, options?: Docker.ImagePushOptions) =>
    dockerManager.images.pushImage(repoTag, options)
  );

  registerHandle(IPC_CHANNELS.Docker.Images.Tag, (imageId: string, repo: string, tag: string) =>
    dockerManager.images.tagImage(imageId, repo, tag)
  );

  registerHandle(IPC_CHANNELS.Docker.Images.Remove, (imageId: string, force?: boolean, pruneChildren?: boolean) =>
    dockerManager.images.removeImage(imageId, force, pruneChildren)
  );

  registerHandle(IPC_CHANNELS.Docker.Images.History, (imageId: string) => dockerManager.images.historyImage(imageId));

  registerHandle(IPC_CHANNELS.Docker.Images.Prune, (filters?: { [key: string]: string[] }) =>
    dockerManager.system.pruneImages(filters)
  );
}
