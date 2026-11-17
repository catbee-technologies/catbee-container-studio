import { Component, ElementRef, computed, inject, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { EnvVarRow, parseEnvFileContent } from '@utils/env.utils';
import { fieldError } from '@utils/configuration-form.utils';

@Component({
  selector: 'catbee-container-studio-env-variables-editor',
  imports: [EmptyStateComponent, FormField],
  templateUrl: './env-variables-editor.html',
  styleUrl: './env-variables-editor.scss'
})
export class EnvVariablesEditorComponent {
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly fields = input.required<FieldTree<EnvVarRow[]>>();
  readonly rows = computed(() => this.fields()().value());
  readonly fieldError = fieldError;
  readonly disabled = input(false);
  readonly keyPlaceholder = input('KEY');
  readonly valuePlaceholder = input('Value');
  readonly showPasteHint = input(true);
  readonly emptyIcon = input('data_object');
  readonly emptyMessage = input('No environment variables set.');
  readonly emptyHint = input(
    'Click "Add Variable" above or paste the contents of an .env file to populate variables automatically.'
  );

  removeRow(index: number): void {
    this.fields()().value.update(current => current.filter((_, i) => i !== index));
    this.fields()().markAsDirty();
  }

  addRow(): void {
    this.fields()().value.update(current => [...current, { key: '', value: '' }]);
    this.fields()().markAsDirty();
    this.scrollToBottomAndFocus();
  }

  scrollToBottomAndFocus(): void {
    setTimeout(() => {
      const container = this.elementRef.nativeElement;
      const rows = container.querySelectorAll('.row-inputs');
      const lastRow = rows[rows.length - 1] as HTMLElement | undefined;
      if (lastRow) {
        const scrollParent = this.getScrollParent(lastRow);
        if (scrollParent) {
          scrollParent.scrollTo({ top: scrollParent.scrollHeight, behavior: 'smooth' });
        } else {
          lastRow.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'smooth' });
        }
        const keyInput = lastRow.querySelector('.col-key-input') as HTMLInputElement | null;
        keyInput?.focus({ preventScroll: true });
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

  onPaste(event: ClipboardEvent, index: number): void {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text.includes('=') && !text.includes('\n')) {
      return;
    }

    const parsedRows = parseEnvFileContent(text);
    if (parsedRows.length === 0) {
      return;
    }

    event.preventDefault();
    this.fields()().value.update(current => {
      const currentRow = current[index];
      const isCurrentEmpty = !!currentRow && !currentRow.key.trim() && !currentRow.value.trim();
      if (isCurrentEmpty) {
        return [...current.slice(0, index), ...parsedRows, ...current.slice(index + 1)];
      }
      return [...current, ...parsedRows];
    });
    this.fields()().markAsDirty();
  }
}
