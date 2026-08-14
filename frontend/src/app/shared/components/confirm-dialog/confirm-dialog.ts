import { CommonModule } from '@angular/common';
import { Component, effect, input, output, signal } from '@angular/core';

@Component({
  selector: 'catbee-container-studio-confirm-dialog',
  imports: [CommonModule],
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.scss'
})
export class ConfirmDialogComponent {
  readonly open = input(false);
  readonly title = input('Confirm');
  readonly message = input('');
  readonly confirmLabel = input('Confirm');
  readonly cancelLabel = input('Cancel');
  readonly dangerous = input(false);

  readonly confirm = output<void>();
  readonly cancelAction = output<void>();

  readonly visible = signal(false);
  readonly closing = signal(false);

  private closeTimer?: ReturnType<typeof setTimeout>;

  readonly localMessage = signal('');

  constructor() {
    effect(() => {
      const open = this.open();

      clearTimeout(this.closeTimer);

      if (open) {
        this.closing.set(false);
        this.visible.set(true);
        this.localMessage.set(this.message());
        return;
      }

      if (this.visible()) {
        this.closing.set(true);

        this.closeTimer = setTimeout(() => {
          this.visible.set(false);
          this.closing.set(false);
          this.localMessage.set('');
        }, 140);
      }
    });
  }

  onConfirm(): void {
    this.confirm.emit();
  }

  onCancel(): void {
    this.cancelAction.emit();
  }

  onBackdropKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
      event.preventDefault();
      this.onCancel();
    }
  }
}
