import { Component, DestroyRef, ElementRef, computed, inject, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { SwitchInputComponent } from '@components/switch-input/switch-input';
import { ElectronApiService } from '@core/electron-api.service';
import { VolumeMappingRow } from '@utils/volume.utils';
import { fieldError } from '@utils/configuration-form.utils';

@Component({
  selector: 'catbee-container-studio-volume-mappings-editor',
  imports: [EmptyStateComponent, SwitchInputComponent, FormField],
  templateUrl: './volume-mappings-editor.html',
  styleUrl: './volume-mappings-editor.scss'
})
export class VolumeMappingsEditorComponent {
  private readonly electronApi = inject(ElectronApiService);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  readonly fields = input.required<FieldTree<VolumeMappingRow[]>>();
  readonly rows = computed(() => this.fields()().value());
  readonly fieldError = fieldError;
  readonly disabled = input(false);
  readonly hostPlaceholder = input('Host path or volume');
  readonly containerPlaceholder = input('Container path');
  readonly emptyIcon = input('folder_open');
  readonly emptyMessage = input('No mounted volumes.');
  readonly emptyHint = input('Click "Add Volume" to map a host folder or volume into the container.');

  removeRow(index: number): void {
    this.fields()().value.update(current => current.filter((_, i) => i !== index));
    this.fields()().markAsDirty();
  }

  addRow(): void {
    this.fields()().value.update(current => [...current, { hostPath: '', containerPath: '', readOnly: false }]);
    this.fields()().markAsDirty();
    this.scrollToBottomAndFocus();
  }

  async pickHostPath(index: number): Promise<void> {
    const hostField = this.fields()[index].hostPath;
    const initialRow = this.fields()[index]().value();
    const selected = await this.electronApi.selectDirectory();
    if (
      !selected ||
      this.destroyRef.destroyed ||
      !Array.from(this.fields()).some(row => row.hostPath === hostField && row().value() === initialRow)
    ) {
      return;
    }
    const field = hostField();
    field.value.set(selected);
    field.markAsDirty();
    field.markAsTouched();
  }

  scrollToBottomAndFocus(): void {
    setTimeout(() => {
      const container = this.elementRef.nativeElement;
      const rows = container.querySelectorAll('.volume-row');
      const lastRow = rows[rows.length - 1] as HTMLElement | undefined;
      if (lastRow) {
        const scrollParent = this.getScrollParent(lastRow);
        if (scrollParent) {
          scrollParent.scrollTo({ top: scrollParent.scrollHeight, behavior: 'smooth' });
        } else {
          lastRow.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'smooth' });
        }
        const inputElem = lastRow.querySelector('.volume-host-input') as HTMLInputElement | null;
        inputElem?.focus({ preventScroll: true });
      }
    }, 0);
  }

  private getScrollParent(element: HTMLElement | null): HTMLElement | null {
    let parent = element?.parentElement;
    while (parent) {
      const overflowY = window.getComputedStyle(parent).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        return parent;
      }
      parent = parent.parentElement;
    }
    return null;
  }
}
