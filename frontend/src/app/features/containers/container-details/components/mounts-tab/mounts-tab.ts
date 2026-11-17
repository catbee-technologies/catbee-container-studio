import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { apply, disabled, form, FormRoot } from '@angular/forms/signals';
import { Router } from '@angular/router';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { VolumeMappingsEditorComponent } from '@components/volume-mappings-editor/volume-mappings-editor';
import { EditHeadingComponent } from '@components/edit-heading/edit-heading';
import { DockerContainerInfo, DockerContainerInspectInfo } from '@shared/types/docker-api.types';
import { ElectronApiService } from '@core/electron-api.service';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { VolumeMappingRow, areVolumeMappingsEqual, dockerBindsToRows, rowsToDockerBinds } from '@utils/volume.utils';
import { resetFormRows, volumeRowsSchema } from '@utils/configuration-form.utils';

interface MountRow {
  type: string;
  source: string;
  name: string;
  displaySource: string;
  destination: string;
  mode: string;
  readWrite: boolean;
  propagation: string;
}

@Component({
  selector: 'catbee-container-studio-container-mounts-tab',
  imports: [
    CommonModule,
    EmptyStateComponent,
    CatbeeTooltip,
    ConfirmDialogComponent,
    VolumeMappingsEditorComponent,
    EditHeadingComponent,
    FormRoot
  ],
  templateUrl: './mounts-tab.html',
  styleUrl: './mounts-tab.scss'
})
export class MountsTabComponent {
  private readonly electronApi = inject(ElectronApiService);
  private readonly router = inject(Router);
  private readonly volumeEditor = viewChild(VolumeMappingsEditorComponent);

  readonly inspectData = input<DockerContainerInspectInfo | null>(null);
  readonly container = input<DockerContainerInfo | null>(null);
  readonly isRecreating = input(false);
  readonly recreate = output<{ binds: string[] }>();
  readonly openContainerPath = output<string>();

  readonly isEditing = signal(false);
  readonly initialBinds = signal<VolumeMappingRow[]>([]);
  readonly editableBinds = signal<VolumeMappingRow[]>([]);
  readonly mountsForm = form(
    this.editableBinds,
    path => {
      apply(path, volumeRowsSchema);
      disabled(path, { when: () => this.isRecreating() });
    },
    { submission: { action: async () => this.requestSave() } }
  );
  readonly isBindsChanged = computed(() => !areVolumeMappingsEqual(this.initialBinds(), this.editableBinds()));
  readonly hasUnsavedChanges = computed(
    () =>
      this.isEditing() &&
      (this.isBindsChanged() ||
        this.editableBinds().some(
          row =>
            (!row.hostPath.trim() || !row.containerPath.trim()) &&
            (row.hostPath.length > 0 || row.containerPath.length > 0 || row.readOnly)
        ))
  );
  readonly showConfirmRecreate = signal(false);
  readonly showConfirmClear = signal(false);
  readonly showConfirmReset = signal(false);
  readonly showConfirmDiscard = signal(false);
  private afterDiscard: (() => void) | undefined;

  readonly mountRows = computed<MountRow[]>(() => {
    const inspectData = this.inspectData();
    if (!inspectData || typeof inspectData !== 'object') {
      return [];
    }

    const record = inspectData as {
      Mounts?: {
        Type?: unknown;
        Name?: unknown;
        Source?: unknown;
        Destination?: unknown;
        Mode?: unknown;
        RW?: unknown;
        Propagation?: unknown;
      }[];
    };

    if (!Array.isArray(record.Mounts)) {
      return [];
    }

    return record.Mounts.map(item => {
      const type = typeof item.Type === 'string' ? item.Type : '--';
      const source = typeof item.Source === 'string' ? item.Source : '--';
      const name = typeof item.Name === 'string' && item.Name.length > 0 ? item.Name : '--';
      const displaySource = type === 'volume' && name !== '--' ? name : source;

      return {
        type,
        source,
        name,
        displaySource,
        destination: typeof item.Destination === 'string' ? item.Destination : '--',
        mode: typeof item.Mode === 'string' && item.Mode.length > 0 ? item.Mode : '--',
        readWrite: Boolean(item.RW),
        propagation: typeof item.Propagation === 'string' && item.Propagation.length > 0 ? item.Propagation : '--'
      };
    }).sort((a, b) => a.destination.localeCompare(b.destination));
  });

  readonly declaredVolumeNames = computed<string[]>(() => {
    const inspectData = this.inspectData();
    if (!inspectData || typeof inspectData !== 'object') {
      return [];
    }

    const record = inspectData as { Config?: { Volumes?: unknown } };
    const volumes = record.Config?.Volumes;
    if (!volumes || typeof volumes !== 'object') {
      return [];
    }

    return Object.keys(volumes as Record<string, unknown>).sort((a, b) => a.localeCompare(b));
  });

  readonly readOnlyMountCount = computed(() => this.mountRows().filter(row => !row.readWrite).length);
  readonly readWriteMountCount = computed(() => this.mountRows().filter(row => row.readWrite).length);

  readonly confirmMessage = computed(() => {
    const name =
      this.container()?.Names?.[0]?.replace(/^\//, '') ||
      this.inspectData()?.Name?.replace(/^\//, '') ||
      'this container';

    const isCompose = Boolean(
      this.container()?.Labels?.['com.docker.compose.service'] ??
      this.inspectData()?.Config?.Labels?.['com.docker.compose.service']
    );

    if (isCompose) {
      return `Force recreate compose container "${name}" with updated mounts? \n This will stop, remove, and recreate the container using Docker Engine with your updated volume mappings. \n\nNote: Running "docker compose up" from CLI in the future will reset volume definitions to the compose file.`;
    }

    return `Force recreate container "${name}" with updated mounts? \n This will stop, remove, and recreate the container using the same configuration with your updated volume mappings.`;
  });

  startEditing(): void {
    const inspect = this.inspectData();
    const existingBinds = dockerBindsToRows(inspect?.HostConfig?.Binds);
    if (existingBinds.length > 0) {
      this.initialBinds.set(existingBinds.map(b => ({ ...b })));
      this.mountsForm().reset(existingBinds);
    } else {
      const fromMounts: VolumeMappingRow[] = this.mountRows()
        .filter(m => m.source !== '--' && m.destination !== '--')
        .map(m => ({
          hostPath: m.type === 'volume' && m.name !== '--' ? m.name : m.source,
          containerPath: m.destination,
          readOnly: !m.readWrite
        }));
      this.initialBinds.set(fromMounts.map(b => ({ ...b })));
      this.mountsForm().reset(
        fromMounts.length > 0 ? fromMounts : [{ hostPath: '', containerPath: '', readOnly: false }]
      );
    }
    this.isEditing.set(true);
  }

  resetEditing(): void {
    if (this.isRecreating()) {
      return;
    }
    if (this.hasUnsavedChanges()) {
      this.showConfirmReset.set(true);
      return;
    }
    this.confirmResetEditing();
  }

  confirmResetEditing(): void {
    if (this.isRecreating()) {
      return;
    }
    this.showConfirmReset.set(false);
    resetFormRows(this.mountsForm, this.initialBinds());
  }

  cancelEditing(afterDiscard?: () => void): void {
    this.afterDiscard = afterDiscard;
    if (this.hasUnsavedChanges()) {
      this.showConfirmDiscard.set(true);
      return;
    }
    this.confirmDiscardEditing();
  }

  cancelDiscardEditing(): void {
    this.showConfirmDiscard.set(false);
    this.afterDiscard = undefined;
  }

  confirmDiscardEditing(): void {
    const afterDiscard = this.afterDiscard;
    this.finishEditing();
    afterDiscard?.();
  }

  finishEditing(): void {
    this.isEditing.set(false);
    this.mountsForm().reset([]);
    this.showConfirmDiscard.set(false);
    this.showConfirmClear.set(false);
    this.showConfirmReset.set(false);
    this.showConfirmRecreate.set(false);
    this.afterDiscard = undefined;
  }

  addMount(): void {
    this.editableBinds.update(rows => [...rows, { hostPath: '', containerPath: '', readOnly: false }]);
    this.mountsForm().markAsDirty();
    this.volumeEditor()?.scrollToBottomAndFocus();
  }

  clearMounts(): void {
    if (this.editableBinds().some(row => row.hostPath.length > 0 || row.containerPath.length > 0 || row.readOnly)) {
      this.showConfirmClear.set(true);
      return;
    }
    this.confirmClearMounts();
  }

  confirmClearMounts(): void {
    this.showConfirmClear.set(false);
    this.editableBinds.set([]);
    this.mountsForm().markAsDirty();
  }

  requestSave(): void {
    if (this.isRecreating()) {
      return;
    }
    this.mountsForm().markAsTouched();
    if (this.mountsForm().invalid() || !this.isBindsChanged()) {
      return;
    }
    this.showConfirmRecreate.set(true);
  }

  cancelSave(): void {
    this.showConfirmRecreate.set(false);
  }

  confirmSaveAndRecreate(): void {
    if (this.isRecreating() || this.mountsForm().invalid() || !this.isBindsChanged()) {
      return;
    }
    this.showConfirmRecreate.set(false);
    const binds = rowsToDockerBinds(this.editableBinds());
    this.recreate.emit({ binds });
  }

  openMountSource(mount: MountRow): void {
    if (mount.source === '--') {
      return;
    }

    if (mount.type === 'volume' && mount.name !== '--') {
      void this.router.navigate(['/volumes', mount.name], { state: { returnTo: this.router.url } });
      return;
    }

    this.openSource(mount.source);
  }

  openSource(source: string): void {
    if (source && source !== '--') {
      this.electronApi.showItemInFolder(source);
    }
  }
}
