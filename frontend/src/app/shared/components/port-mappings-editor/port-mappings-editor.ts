import { Component, computed, input, signal } from '@angular/core';
import { apply, disabled, FieldTree, form, FormField, submit, validate } from '@angular/forms/signals';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { hostPortsConflict, PortMappingRow } from '@utils/port.utils';
import { fieldError, portMappingSchema } from '@utils/configuration-form.utils';

@Component({
  selector: 'catbee-container-studio-port-mappings-editor',
  imports: [EmptyStateComponent, CatbeeTooltip, ConfirmDialogComponent, FormField],
  templateUrl: './port-mappings-editor.html',
  styleUrl: './port-mappings-editor.scss'
})
export class PortMappingsEditorComponent {
  readonly fields = input.required<FieldTree<PortMappingRow[]>>();
  readonly rows = computed(() => this.fields()().value());
  readonly fieldError = fieldError;
  readonly isLoading = input(false);
  readonly disabled = input(false);
  readonly allowAdd = input(false);
  readonly allowRemove = input(false);
  readonly emptyIcon = input('router');
  readonly emptyMessage = input('This image does not expose any ports.');
  readonly emptyHint = input('Enter a host port (e.g. 8080) or "0" to assign a random port.');
  readonly loadingMessage = input('Checking exposed ports...');

  readonly showAddForm = signal(false);
  private readonly newPortModel = signal<PortMappingRow>({ hostPort: '', containerPort: '', protocol: 'tcp' });
  readonly newPortForm = form(this.newPortModel, path => {
    apply(path, portMappingSchema);
    disabled(path, { when: () => this.disabled() });
    validate(path.hostPort, ({ value, valueOf }) => {
      const hostPort = value().trim();
      if (!hostPort || hostPort === '0') {
        return undefined;
      }
      const duplicate = this.rows().find(row => hostPortsConflict(row, valueOf(path)));
      return duplicate
        ? {
            kind: 'duplicate',
            message: `Host port ${hostPort} is already assigned to container port :${duplicate.containerPort}/${duplicate.protocol}.`
          }
        : undefined;
    });
    validate(path.containerPort, ({ value, valueOf }) =>
      this.rows().some(row => row.containerPort === value() && row.protocol === valueOf(path.protocol))
        ? { kind: 'duplicate', message: `Port ${value()}/${valueOf(path.protocol)} is already in the list.` }
        : undefined
    );
  });
  readonly showConfirmDiscard = signal(false);
  readonly hasAddFormChanges = computed(
    () =>
      this.showAddForm() &&
      (this.newPortModel().hostPort.length > 0 ||
        this.newPortModel().containerPort.length > 0 ||
        this.newPortModel().protocol !== 'tcp')
  );
  readonly newHostPortError = computed(() => fieldError(this.newPortForm.hostPort(), true));
  readonly newContainerPortError = computed(() => fieldError(this.newPortForm.containerPort(), true));

  normalizePortInput(field: FieldTree<string>, event: Event): void {
    const target = event.target as HTMLInputElement;
    const sanitized = target.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
    if (target.value !== sanitized) {
      target.value = sanitized;
    }
    field().value.set(sanitized);
    field().markAsDirty();
  }

  openAddForm(): void {
    this.resetAddForm();
    this.showAddForm.set(true);
  }

  resetAddForm(): void {
    this.showAddForm.set(false);
    this.newPortForm().reset({ hostPort: '', containerPort: '', protocol: 'tcp' });
    this.showConfirmDiscard.set(false);
  }

  cancelAddForm(): void {
    if (this.hasAddFormChanges()) {
      this.showConfirmDiscard.set(true);
      return;
    }
    this.resetAddForm();
  }

  async confirmAddPort(): Promise<void> {
    if (this.disabled()) {
      return;
    }
    await submit(this.newPortForm, async () => {
      this.fields()().value.update(current => [...current, { ...this.newPortModel() }]);
      this.fields()().markAsDirty();
      this.resetAddForm();
    });
  }

  removeRow(index: number): void {
    this.fields()().value.update(current => current.filter((_, i) => i !== index));
    this.fields()().markAsDirty();
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
