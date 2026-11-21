import { Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

export type CalloutType = 'info' | 'warning' | 'error' | 'success' | 'subtle';

@Component({
  selector: 'catbee-container-studio-callout',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './callout.html',
  styleUrl: './callout.scss'
})
export class CalloutComponent {
  readonly type = input<CalloutType>('info');
  readonly icon = input<string>('');
  readonly title = input<string>('');
  readonly closable = input<boolean>(false);

  readonly closed = output<void>();
  readonly visible = signal(true);

  protected readonly resolvedIcon = computed(() => {
    const custom = this.icon();
    if (custom) return custom;
    switch (this.type()) {
      case 'warning':
        return 'warning';
      case 'error':
        return 'error';
      case 'success':
        return 'check_circle';
      case 'subtle':
        return 'info';
      case 'info':
      default:
        return 'info';
    }
  });

  onClose(event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.visible.set(false);
    this.closed.emit();
  }
}
