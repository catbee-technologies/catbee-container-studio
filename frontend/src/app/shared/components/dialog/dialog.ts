import { Component, TemplateRef, effect, input, output, viewChild } from '@angular/core';
import { DialogOverlayBase } from './dialog.base';

@Component({
  selector: 'catbee-container-studio-dialog',
  templateUrl: './dialog.html',
  styleUrl: './dialog.scss'
})
export class DialogComponent extends DialogOverlayBase {
  readonly open = input(false);
  readonly title = input('Dialog');
  readonly style = input<Record<string, string>>({});

  readonly closeDialog = output<void>();

  readonly titleId = `catbee-dialog-title-${crypto.randomUUID()}`;

  readonly dialogTemplate = viewChild.required<TemplateRef<unknown>>('dialogTemplate');

  constructor() {
    super();

    effect(() => {
      if (this.open()) {
        this.openDialogOverlay(this.dialogTemplate());
      } else {
        this.closeDialogOverlay();
      }
    });
  }

  protected override onOverlayCancel(): void {
    this.onClose();
  }

  onClose(): void {
    this.closeDialog.emit();
  }
}
