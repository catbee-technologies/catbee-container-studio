import { Component, effect, input, output, signal } from '@angular/core';

@Component({
  selector: 'catbee-container-studio-dialog',
  templateUrl: './dialog.html',
  styleUrl: './dialog.scss'
})
export class DialogComponent {
  readonly open = input(false);
  readonly title = input('Dialog');

  readonly closeDialog = output<void>();

  readonly visible = signal(false);
  readonly closing = signal(false);

  readonly titleId = `catbee-dialog-title-${crypto.randomUUID()}`;

  private closeTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      const open = this.open();

      clearTimeout(this.closeTimer);

      if (open) {
        this.closing.set(false);
        this.visible.set(true);
        return;
      }

      if (this.visible()) {
        this.closing.set(true);

        this.closeTimer = setTimeout(() => {
          this.visible.set(false);
          this.closing.set(false);
        }, 140);
      }
    });
  }

  onClose(): void {
    this.closeDialog.emit();
  }

  onBackdropKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.onClose();
    }
  }
}
