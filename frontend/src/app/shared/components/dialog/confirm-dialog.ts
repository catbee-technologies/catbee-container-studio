import { Component, TemplateRef, effect, input, output, signal, viewChild } from '@angular/core';
import { DialogOverlayBase } from './dialog.base';

@Component({
  selector: 'catbee-container-studio-confirm-dialog',
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.scss'
})
export class ConfirmDialogComponent extends DialogOverlayBase {
  readonly open = input(false);
  readonly title = input('Confirm');
  readonly message = input('');
  readonly confirmLabel = input('Confirm');
  readonly cancelLabel = input('Cancel');
  readonly dangerous = input(false);
  readonly style = input<Record<string, string>>({});

  readonly confirm = output<void>();
  readonly cancelAction = output<void>();

  readonly localMessage = signal('');

  readonly titleId = `catbee-confirm-dialog-title-${crypto.randomUUID()}`;

  readonly dialogTemplate = viewChild.required<TemplateRef<unknown>>('dialogTemplate');

  constructor() {
    super();

    effect(() => {
      if (this.open()) {
        this.localMessage.set(this.message());
        this.openDialogOverlay(this.dialogTemplate());
      } else {
        this.closeDialogOverlay();
      }
    });
  }

  protected override getPanelClass(): string {
    return 'catbee-confirm-dialog-overlay-panel';
  }

  protected override onOverlayCancel(): void {
    this.onCancel();
  }

  onConfirm(): void {
    this.confirm.emit();
  }

  onCancel(): void {
    this.cancelAction.emit();
  }
}
