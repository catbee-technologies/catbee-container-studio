import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';

type CopyButtonStatus = 'idle' | 'copied' | 'failed';

@Component({
  selector: 'catbee-container-studio-copy-button',
  imports: [CatbeeTooltip],
  templateUrl: './copy-button.html',
  styleUrl: './copy-button.scss'
})
export class CopyButtonComponent {
  private readonly destroyRef = inject(DestroyRef);

  readonly text = input('');
  readonly ariaLabel = input('Copy to clipboard');
  readonly idleTitle = input('Copy');
  readonly successTitle = input('Copied');
  readonly failureTitle = input('Copy failed');
  readonly disabled = input(false);
  readonly size = input<'small' | 'medium' | 'large'>('medium');
  readonly className = input('');

  readonly status = signal<CopyButtonStatus>('idle');
  readonly isDisabled = computed(() => this.disabled() || this.text().length === 0);
  readonly buttonTitle = computed(() => {
    switch (this.status()) {
      case 'copied':
        return this.successTitle();
      case 'failed':
        return this.failureTitle();
      default:
        return this.idleTitle();
    }
  });
  readonly iconName = computed(() => {
    switch (this.status()) {
      case 'copied':
        return 'check';
      case 'failed':
        return 'error';
      default:
        return 'content_copy';
    }
  });

  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.resetTimer !== null) {
        clearTimeout(this.resetTimer);
      }
    });
  }

  async copy(): Promise<void> {
    if (this.isDisabled()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(this.text());
      this.status.set('copied');
    } catch {
      this.status.set('failed');
    }

    this.scheduleReset();
  }

  private scheduleReset(): void {
    if (this.resetTimer !== null) {
      clearTimeout(this.resetTimer);
    }

    this.resetTimer = setTimeout(() => {
      this.status.set('idle');
      this.resetTimer = null;
    }, 1600);
  }
}
