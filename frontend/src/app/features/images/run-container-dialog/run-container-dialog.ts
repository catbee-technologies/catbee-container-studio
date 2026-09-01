import { Component, effect, inject, input, output, signal } from '@angular/core';
import type Docker from 'dockerode';
import { DockerApiService } from '@core/docker-api.service';
import { ElectronApiService } from '@core/electron-api.service';
import { DialogComponent } from '@components/dialog/dialog';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { SwitchInputComponent } from '@components/switch-input/switch-input';

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

interface EnvVarRow {
  key: string;
  value: string;
}

@Component({
  selector: 'catbee-container-studio-run-container-dialog',
  imports: [DialogComponent, ErrorBannerComponent, SwitchInputComponent],
  templateUrl: './run-container-dialog.html',
  styleUrl: './run-container-dialog.scss'
})
export class RunContainerDialogComponent {
  private readonly dockerApi = inject(DockerApiService);
  private readonly electronApi = inject(ElectronApiService);

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
  }

  clearEnvVars(): void {
    this.envVars.set([]);
  }

  removeEnvVar(index: number): void {
    this.envVars.update(rows => rows.filter((_, i) => i !== index));
  }

  setEnvKey(index: number, value: string): void {
    this.envVars.update(rows => rows.map((row, i) => (i === index ? { ...row, key: value } : row)));
  }

  setEnvValue(index: number, value: string): void {
    this.envVars.update(rows => rows.map((row, i) => (i === index ? { ...row, value } : row)));
  }

  onEnvPaste(event: ClipboardEvent, index: number): void {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text.includes('=') && !text.includes('\n')) {
      return;
    }

    const parsedRows = this.parseEnvFileContent(text);
    if (parsedRows.length === 0) {
      return;
    }

    event.preventDefault();
    this.envVars.update(rows => {
      const currentRow = rows[index];
      const isCurrentEmpty = !!currentRow && !currentRow.key.trim() && !currentRow.value.trim();
      if (isCurrentEmpty) {
        return [...rows.slice(0, index), ...parsedRows, ...rows.slice(index + 1)];
      }
      return [...rows, ...parsedRows];
    });
  }

  private parseEnvFileContent(content: string): EnvVarRow[] {
    return content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'))
      .map((line): EnvVarRow | null => {
        const eqIndex = line.indexOf('=');
        if (eqIndex === -1) {
          return null;
        }
        const key = line.slice(0, eqIndex).trim();
        if (!key) {
          return null;
        }
        let value = line.slice(eqIndex + 1).trim();
        const isQuoted =
          (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
        if (isQuoted && value.length >= 2) {
          value = value.slice(1, -1);
        }
        return { key, value };
      })
      .filter((row): row is EnvVarRow => row !== null);
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

    const env = this.envVars()
      .filter(row => row.key.trim().length > 0)
      .map(row => `${row.key.trim()}=${row.value}`);

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
