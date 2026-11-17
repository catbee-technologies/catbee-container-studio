import { Component, computed, input, output, signal } from '@angular/core';
import { formatErrorMessage } from '@utils/error-message.utils';

@Component({
  selector: 'catbee-container-studio-error-banner',
  templateUrl: './error-banner.html',
  styleUrl: './error-banner.scss'
})
export class ErrorBannerComponent {
  readonly errorMessage = input.required<string>();
  readonly formattedError = computed(() => formatErrorMessage(this.errorMessage()));
  readonly closable = input<boolean>(true);
  readonly size = input<'small' | 'medium' | 'large'>('medium');
  readonly closeErr = output<void>();

  readonly visible = signal(true);

  onClose() {
    this.visible.set(false);
    this.closeErr.emit();
  }
}
