import { Component, input, model } from '@angular/core';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { PortMappingRow } from '@utils/port.utils';

@Component({
  selector: 'catbee-container-studio-port-mappings-editor',
  imports: [EmptyStateComponent],
  templateUrl: './port-mappings-editor.html',
  styleUrl: './port-mappings-editor.scss'
})
export class PortMappingsEditorComponent {
  readonly rows = model<PortMappingRow[]>([]);
  readonly isLoading = input(false);
  readonly disabled = input(false);
  readonly allowAdd = input(false);
  readonly emptyIcon = input('router');
  readonly emptyMessage = input('This image does not expose any ports.');
  readonly emptyHint = input('Enter a host port (e.g. 8080) or "0" to assign a random port.');
  readonly loadingMessage = input('Checking exposed ports...');

  setPortHost(index: number, value: string): void {
    const sanitized = value.replace(/[^0-9]/g, '').slice(0, 5);
    this.rows.update(current => current.map((row, i) => (i === index ? { ...row, hostPort: sanitized } : row)));
  }

  setContainerPort(index: number, value: string): void {
    const sanitized = value.replace(/[^0-9]/g, '').slice(0, 5);
    this.rows.update(current => current.map((row, i) => (i === index ? { ...row, containerPort: sanitized } : row)));
  }

  setProtocol(index: number, protocol: 'tcp' | 'udp'): void {
    this.rows.update(current => current.map((row, i) => (i === index ? { ...row, protocol } : row)));
  }

  addRow(): void {
    this.rows.update(current => [...current, { containerPort: '', protocol: 'tcp', hostPort: '' }]);
  }

  removeRow(index: number): void {
    this.rows.update(current => current.filter((_, i) => i !== index));
  }

  onPortHostInput(event: Event, index: number): void {
    const target = event.target as HTMLInputElement;
    const sanitized = target.value.replace(/[^0-9]/g, '').slice(0, 5);
    if (target.value !== sanitized) {
      target.value = sanitized;
    }
    this.setPortHost(index, sanitized);
  }

  onPortContainerInput(event: Event, index: number): void {
    const target = event.target as HTMLInputElement;
    const sanitized = target.value.replace(/[^0-9]/g, '').slice(0, 5);
    if (target.value !== sanitized) {
      target.value = sanitized;
    }
    this.setContainerPort(index, sanitized);
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
      'End'
    ];
    if (allowedKeys.includes(event.key)) {
      return;
    }
    if (!/^[0-9]$/.test(event.key)) {
      event.preventDefault();
    }
  }
}
