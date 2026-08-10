import type Docker from 'dockerode';
import { createDockerClient } from './docker.client';
import { DockerActionResult } from './docker.types';

export class DockerService {
  private readonly client: Docker;

  constructor() {
    this.client = createDockerClient();
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async info(): Promise<unknown> {
    return this.client.info();
  }

  async listContainers(): Promise<Docker.ContainerInfo[]> {
    const containers = await this.client.listContainers({
      all: true
    });
    return containers;
  }

  async startContainer(containerId: string): Promise<DockerActionResult> {
    const id = containerId.trim();

    if (!id) {
      throw new Error('Container id is required.');
    }

    const container = this.client.getContainer(id);

    await container.start();

    return {
      containerId: id,
      output: ''
    };
  }

  async stopContainer(containerId: string): Promise<DockerActionResult> {
    const id = containerId.trim();

    if (!id) {
      throw new Error('Container id is required.');
    }

    const container = this.client.getContainer(id);

    await container.stop();

    return {
      containerId: id,
      output: ''
    };
  }
}
