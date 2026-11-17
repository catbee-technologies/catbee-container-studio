import { Component, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { apply, disabled, form, FormField, FormRoot } from '@angular/forms/signals';
import type Docker from 'dockerode';
import { DockerApiService } from '@core/docker-api.service';
import { DialogComponent } from '@components/dialog/dialog';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { EnvVariablesEditorComponent } from '@components/env-variables-editor/env-variables-editor';
import { VolumeMappingsEditorComponent } from '@components/volume-mappings-editor/volume-mappings-editor';
import { PortMappingsEditorComponent } from '@components/port-mappings-editor/port-mappings-editor';
import { EnvVarRow, rowsToDockerEnv } from '@utils/env.utils';
import { VolumeMappingRow, rowsToDockerBinds } from '@utils/volume.utils';
import { PortMappingRow, rowsToDockerPortBindings } from '@utils/port.utils';
import { envRowsSchema, portRowsSchema, volumeRowsSchema } from '@utils/configuration-form.utils';

interface RunContainerFormValue {
  containerName: string;
  ports: PortMappingRow[];
  volumes: VolumeMappingRow[];
  envVars: EnvVarRow[];
}

@Component({
  selector: 'catbee-container-studio-run-container-dialog',
  imports: [
    DialogComponent,
    ConfirmDialogComponent,
    ErrorBannerComponent,
    EnvVariablesEditorComponent,
    VolumeMappingsEditorComponent,
    PortMappingsEditorComponent,
    FormField,
    FormRoot
  ],
  templateUrl: './run-container-dialog.html',
  styleUrl: './run-container-dialog.scss'
})
export class RunContainerDialogComponent {
  private readonly dockerApi = inject(DockerApiService);
  private readonly envEditor = viewChild(EnvVariablesEditorComponent);
  private readonly volumeEditor = viewChild(VolumeMappingsEditorComponent);

  readonly open = input(false);
  readonly image = input('');

  readonly closeDialog = output<void>();
  readonly created = output<string>();

  private readonly formModel = signal<RunContainerFormValue>({
    containerName: '',
    ports: [],
    volumes: [],
    envVars: []
  });
  readonly runForm = form(
    this.formModel,
    path => {
      apply(path.ports, portRowsSchema);
      apply(path.volumes, volumeRowsSchema);
      apply(path.envVars, envRowsSchema);
      disabled(path, { when: () => this.isSubmitting() });
    },
    { submission: { action: async () => this.run() } }
  );
  readonly containerName = this.runForm.containerName().value;
  readonly ports = this.runForm.ports().value;
  readonly volumes = this.runForm.volumes().value;
  readonly envVars = this.runForm.envVars().value;
  readonly hasUnsavedChanges = computed(
    () =>
      this.containerName().length > 0 ||
      this.ports().some(row => row.hostPort.length > 0) ||
      this.volumes().some(row => row.hostPath.length > 0 || row.containerPath.length > 0 || row.readOnly) ||
      this.envVars().some(row => row.key.length > 0 || row.value.length > 0)
  );
  readonly isSubmitting = signal(false);
  readonly isLoadingPorts = signal(false);
  readonly isDialogReady = signal(false);
  readonly error = signal<string | null>(null);
  readonly showConfirmClose = signal(false);
  readonly clearTarget = signal<'volumes' | 'env' | null>(null);

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

  addVolume(): void {
    this.volumes.update(rows => [...rows, { hostPath: '', containerPath: '', readOnly: false }]);
    this.runForm.volumes().markAsDirty();
    this.volumeEditor()?.scrollToBottomAndFocus();
  }

  clearVolumes(): void {
    if (this.volumes().some(row => row.hostPath.length > 0 || row.containerPath.length > 0 || row.readOnly)) {
      this.clearTarget.set('volumes');
      return;
    }
    this.volumes.set([]);
    this.runForm.volumes().markAsDirty();
  }

  addEnvVar(): void {
    this.envVars.update(rows => [...rows, { key: '', value: '' }]);
    this.runForm.envVars().markAsDirty();
    this.envEditor()?.scrollToBottomAndFocus();
  }

  clearEnvVars(): void {
    if (this.envVars().some(row => row.key.length > 0 || row.value.length > 0)) {
      this.clearTarget.set('env');
      return;
    }
    this.envVars.set([]);
    this.runForm.envVars().markAsDirty();
  }

  confirmClear(): void {
    if (this.clearTarget() === 'volumes') {
      this.volumes.set([]);
      this.runForm.volumes().markAsDirty();
    } else if (this.clearTarget() === 'env') {
      this.envVars.set([]);
      this.runForm.envVars().markAsDirty();
    }
    this.clearTarget.set(null);
  }

  onClose(): void {
    if (this.isSubmitting()) {
      return;
    }
    if (this.hasUnsavedChanges()) {
      this.showConfirmClose.set(true);
      return;
    }
    this.confirmClose();
  }

  confirmClose(): void {
    this.showConfirmClose.set(false);
    this.closeDialog.emit();
  }

  async run(): Promise<void> {
    const image = this.image().trim();
    if (!image || this.isSubmitting()) {
      return;
    }
    this.runForm().markAsTouched();
    if (this.runForm().invalid()) {
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
    const { exposedPorts, portBindings } = rowsToDockerPortBindings(this.ports());
    const binds = rowsToDockerBinds(this.volumes());
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
    this.showConfirmClose.set(false);
    this.clearTarget.set(null);
    this.runForm().reset({ containerName: '', ports: [], volumes: [], envVars: [] });
    this.error.set(null);
    this.isSubmitting.set(false);
  }
}
