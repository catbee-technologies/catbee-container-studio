import { Component, computed, input, model, signal } from '@angular/core';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { PortMappingRow, findDuplicateHostPorts } from '@utils/port.utils';

@Component({
  selector: 'catbee-container-studio-port-mappings-editor',
  imports: [EmptyStateComponent, CatbeeTooltip],
  templateUrl: './port-mappings-editor.html',
  styleUrl: './port-mappings-editor.scss'
})
export class PortMappingsEditorComponent {
  readonly rows = model<PortMappingRow[]>([]);
  readonly isLoading = input(false);
  readonly disabled = input(false);
  readonly allowAdd = input(false);
  readonly allowRemove = input(false);
  readonly emptyIcon = input('router');
  readonly emptyMessage = input('This image does not expose any ports.');
  readonly emptyHint = input('Enter a host port (e.g. 8080) or "0" to assign a random port.');
  readonly loadingMessage = input('Checking exposed ports...');

  readonly showAddForm = signal(false);
  readonly newHostPort = signal('');
  readonly newContainerPort = signal('');
  readonly newProtocol = signal<'tcp' | 'udp'>('tcp');
  readonly addError = signal<string | null>(null);

  readonly duplicateHostPorts = computed(() => findDuplicateHostPorts(this.rows()));

  isDuplicateHostPort(port: PortMappingRow): boolean {
    const h = port.hostPort.trim();
    if (!h || h === '0') {
      return false;
    }
    return this.duplicateHostPorts().has(`${h}/${port.protocol}`);
  }

  setPortHost(index: number, value: string): void {
    const sanitized = value.replace(/[^0-9]/g, '').slice(0, 5);
    this.rows.update(current => current.map((row, i) => (i === index ? { ...row, hostPort: sanitized } : row)));
  }

  sanitizePortInput(event: Event): string {
    const target = event.target as HTMLInputElement;
    const sanitized = target.value.replace(/[^0-9]/g, '').slice(0, 5);
    if (target.value !== sanitized) {
      target.value = sanitized;
    }
    return sanitized;
  }

  openAddForm(): void {
    this.newHostPort.set('');
    this.newContainerPort.set('');
    this.newProtocol.set('tcp');
    this.addError.set(null);
    this.showAddForm.set(true);
  }

  cancelAddForm(): void {
    this.showAddForm.set(false);
    this.addError.set(null);
  }

  confirmAddPort(): void {
    const protocol = this.newProtocol();
    const cPort = this.newContainerPort().trim();
    if (!cPort) {
      this.addError.set('Container port is required');
      return;
    }

    const cNum = Number.parseInt(cPort, 10);
    if (Number.isNaN(cNum) || cNum < 1 || cNum > 65535) {
      this.addError.set('Container port must be between 1 and 65535');
      return;
    }

    const hPort = this.newHostPort().trim();
    if (hPort) {
      const hNum = Number.parseInt(hPort, 10);
      if (Number.isNaN(hNum) || hNum < 0 || hNum > 65535) {
        this.addError.set('Host port must be between 0 and 65535');
        return;
      }
      if (hPort !== '0') {
        const duplicateHost = this.rows().find(r => r.hostPort.trim() === hPort && r.protocol === protocol);
        if (duplicateHost) {
          this.addError.set(
            `Host port ${hPort} is already assigned to container port :${duplicateHost.containerPort}/${duplicateHost.protocol}`
          );
          return;
        }
      }
    }

    const existing = this.rows().find(r => r.containerPort === cPort && r.protocol === protocol);
    if (existing) {
      this.addError.set(`Port ${cPort}/${protocol} is already in the list`);
      return;
    }

    this.rows.update(current => [
      ...current,
      {
        containerPort: cPort,
        protocol,
        hostPort: hPort
      }
    ]);

    this.showAddForm.set(false);
    this.addError.set(null);
  }

  removeRow(index: number): void {
    this.rows.update(current => current.filter((_, i) => i !== index));
  }

  onPortKeydown(event: KeyboardEvent): void {
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
      'End',
      'Enter'
    ];
    if (allowedKeys.includes(event.key)) {
      return;
    }
    if (!/^[0-9]$/.test(event.key)) {
      event.preventDefault();
    }
  }
}
