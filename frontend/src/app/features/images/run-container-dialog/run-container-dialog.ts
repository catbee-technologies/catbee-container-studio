import { Component, effect, inject, input, output, signal, viewChild } from '@angular/core';
import type Docker from 'dockerode';
import { DockerApiService } from '@core/docker-api.service';
import { ElectronApiService } from '@core/electron-api.service';
import { DialogComponent } from '@components/dialog/dialog';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { SwitchInputComponent } from '@components/switch-input/switch-input';
import { EnvVariablesEditorComponent } from '@components/env-variables-editor/env-variables-editor';
import { EnvVarRow, rowsToDockerEnv } from '@utils/env.utils';

interface PortMappingRow {
  containerPort: string;
  protocol: 'tcp' | 'udp';
  hostPort: string;
}

interface VolumeMappingRow {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

@Component({
  selector: 'catbee-container-studio-run-container-dialog',
  imports: [DialogComponent, ErrorBannerComponent, SwitchInputComponent, EnvVariablesEditorComponent],
  templateUrl: './run-container-dialog.html',
  styleUrl: './run-container-dialog.scss'
})
export class RunContainerDialogComponent {
  private readonly dockerApi = inject(DockerApiService);
  private readonly electronApi = inject(ElectronApiService);
  private readonly envEditor = viewChild(EnvVariablesEditorComponent);

  readonly open = input(false);
  readonly image = input('');

  readonly closeDialog = output<void>();
  readonly created = output<string>();

  readonly containerName = signal('');
  readonly ports = signal<PortMappingRow[]>([]);
  readonly volumes = signal<VolumeMappingRow[]>([]);
  readonly envVars = signal<EnvVarRow[]>([]);
  readonly isSubmitting = signal(false);
  readonly isLoadingPorts = signal(false);
  readonly isDialogReady = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const image = this.image();
      if (this.open()) {
        this.isDialogReady.set(false);
        this.resetForm();
        void this.prepareForm(image);
      } else {
        this.isDialogReady.set(false);
      }
    });
  }

  private async prepareForm(image: string): Promise<void> {
    await this.loadExposedPorts(image);
    if (this.open()) {
      this.isDialogReady.set(true);
    }
  }

  private async loadExposedPorts(image: string): Promise<void> {
    const trimmedImage = image.trim();
    if (!trimmedImage) {
      return;
    }

    this.isLoadingPorts.set(true);
    try {
      const inspectInfo = await this.dockerApi.inspectImage(trimmedImage);
      const entries = Object.keys(inspectInfo.Config?.ExposedPorts ?? {});

      const rows: PortMappingRow[] = entries
        .map((entry): PortMappingRow => {
          const [containerPort, protocol] = entry.split('/');
          return {
            containerPort: containerPort ?? '',
            protocol: protocol === 'udp' ? 'udp' : 'tcp',
            hostPort: ''
          };
        })
        .filter(row => row.containerPort)
        .sort((left, right) => Number(left.containerPort) - Number(right.containerPort));

      this.ports.set(rows);
    } catch {
      // Image metadata unavailable; leave the ports list empty for manual review.
      this.ports.set([]);
    } finally {
      this.isLoadingPorts.set(false);
    }
  }

  setPortHost(index: number, value: string): void {
    const sanitized = value.replace(/[^0-9]/g, '').slice(0, 5);
    this.ports.update(rows => rows.map((row, i) => (i === index ? { ...row, hostPort: sanitized } : row)));
  }

  onPortHostInput(event: Event, index: number): void {
    const target = event.target as HTMLInputElement;
    const sanitized = target.value.replace(/[^0-9]/g, '').slice(0, 5);
    if (target.value !== sanitized) {
      target.value = sanitized;
    }
    this.setPortHost(index, sanitized);
  }

  onPortHostKeydown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const allowedKeys = [
      'Backspace',
      'Delete',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Tab',
      'Home',
      'End'
    ];
    if (allowedKeys.includes(event.key)) {
      return;
    }
    if (!/^[0-9]$/.test(event.key)) {
      event.preventDefault();
    }
  }

  addVolume(): void {
    this.volumes.update(rows => [...rows, { hostPath: '', containerPath: '', readOnly: false }]);
  }

  clearVolumes(): void {
    this.volumes.set([]);
  }

  removeVolume(index: number): void {
    this.volumes.update(rows => rows.filter((_, i) => i !== index));
  }

  setVolumeHost(index: number, value: string): void {
    this.volumes.update(rows => rows.map((row, i) => (i === index ? { ...row, hostPath: value } : row)));
  }

  setVolumeContainer(index: number, value: string): void {
    this.volumes.update(rows => rows.map((row, i) => (i === index ? { ...row, containerPath: value } : row)));
  }

  async pickVolumeHostPath(index: number): Promise<void> {
    const selectedPath = await this.electronApi.selectDirectory();
    if (!selectedPath) {
      return;
    }
    this.setVolumeHost(index, selectedPath);
  }

  toggleVolumeReadOnly(index: number): void {
    this.volumes.update(rows => rows.map((row, i) => (i === index ? { ...row, readOnly: !row.readOnly } : row)));
  }

  setVolumeReadOnly(index: number, readOnly: boolean): void {
    this.volumes.update(rows => rows.map((row, i) => (i === index ? { ...row, readOnly } : row)));
  }

  addEnvVar(): void {
    this.envVars.update(rows => [...rows, { key: '', value: '' }]);
    this.envEditor()?.scrollToBottomAndFocus();
  }

  clearEnvVars(): void {
    this.envVars.set([]);
  }

  onClose(): void {
    if (this.isSubmitting()) {
      return;
    }
    this.closeDialog.emit();
  }

  async run(): Promise<void> {
    const image = this.image().trim();
    if (!image || this.isSubmitting()) {
      return;
    }

    this.isSubmitting.set(true);
    this.error.set(null);

    try {
      const options = this.buildCreateOptions(image);
      const inspectInfo = await this.dockerApi.createContainer(options);
      const containerId = inspectInfo.Id;
      if (!containerId) {
        throw new Error('Container was created but no id was returned.');
      }
      await this.dockerApi.startContainer(containerId);
      this.created.emit(containerId);
      this.closeDialog.emit();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to run the container.');
    } finally {
      this.isSubmitting.set(false);
    }
  }

  private buildCreateOptions(image: string): Docker.ContainerCreateOptions {
    const exposedPorts: Record<string, Record<string, never>> = {};
    const portBindings: Record<string, { HostPort: string }[]> = {};

    for (const port of this.ports()) {
      const containerPort = port.containerPort.trim();
      if (!containerPort) {
        continue;
      }
      const key = `${containerPort}/${port.protocol}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: port.hostPort.trim() === '0' ? '' : port.hostPort.trim() }];
    }

    const binds: string[] = [];
    for (const volume of this.volumes()) {
      const hostPath = volume.hostPath.trim();
      const containerPath = volume.containerPath.trim();
      if (!hostPath || !containerPath) {
        continue;
      }
      binds.push(`${hostPath}:${containerPath}${volume.readOnly ? ':ro' : ''}`);
    }

    const env = rowsToDockerEnv(this.envVars());
    const name = this.containerName().trim();

    return {
      ...(name ? { name } : {}),
      Image: image,
      ...(env.length > 0 ? { Env: env } : {}),
      ...(Object.keys(exposedPorts).length > 0 ? { ExposedPorts: exposedPorts } : {}),
      HostConfig: {
        ...(Object.keys(portBindings).length > 0 ? { PortBindings: portBindings } : {}),
        ...(binds.length > 0 ? { Binds: binds } : {})
      }
    };
  }

  private resetForm(): void {
    this.containerName.set('');
    this.ports.set([]);
    this.volumes.set([]);
    this.envVars.set([]);
    this.error.set(null);
    this.isSubmitting.set(false);
  }
}
