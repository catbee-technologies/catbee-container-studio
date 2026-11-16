import { Component, ElementRef, inject, input, model } from '@angular/core';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { SwitchInputComponent } from '@components/switch-input/switch-input';
import { ElectronApiService } from '@core/electron-api.service';
import { VolumeMappingRow } from '@utils/volume.utils';

@Component({
  selector: 'catbee-container-studio-volume-mappings-editor',
  imports: [EmptyStateComponent, SwitchInputComponent],
  templateUrl: './volume-mappings-editor.html',
  styleUrl: './volume-mappings-editor.scss'
})
export class VolumeMappingsEditorComponent {
  private readonly electronApi = inject(ElectronApiService);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly rows = model<VolumeMappingRow[]>([]);
  readonly disabled = input(false);
  readonly hostPlaceholder = input('Host path or volume');
  readonly containerPlaceholder = input('Container path');
  readonly emptyIcon = input('folder_open');
  readonly emptyMessage = input('No mounted volumes.');
  readonly emptyHint = input('Click "Add Volume" to map a host folder or volume into the container.');

  setHost(index: number, hostPath: string): void {
    this.rows.update(current => current.map((row, i) => (i === index ? { ...row, hostPath } : row)));
  }

  setContainer(index: number, containerPath: string): void {
    this.rows.update(current => current.map((row, i) => (i === index ? { ...row, containerPath } : row)));
  }

  setReadOnly(index: number, readOnly: boolean): void {
    this.rows.update(current => current.map((row, i) => (i === index ? { ...row, readOnly } : row)));
  }

  removeRow(index: number): void {
    this.rows.update(current => current.filter((_, i) => i !== index));
  }

  addRow(): void {
    this.rows.update(current => [...current, { hostPath: '', containerPath: '', readOnly: false }]);
    this.scrollToBottomAndFocus();
  }

  async pickHostPath(index: number): Promise<void> {
    const selected = await this.electronApi.selectDirectory();
    if (!selected) {
      return;
    }
    this.setHost(index, selected);
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
