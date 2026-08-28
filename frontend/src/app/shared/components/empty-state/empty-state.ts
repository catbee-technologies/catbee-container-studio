import { Component, effect, inject, input, untracked } from '@angular/core';
import { CatbeeLoaderComponent, CatbeeLoaderService } from '@ng-catbee/loader';

@Component({
  selector: 'catbee-container-studio-empty-state',
  templateUrl: './empty-state.html',
  styleUrls: ['./empty-state.scss'],
  imports: [CatbeeLoaderComponent],
  host: {
    height: '100%'
  }
})
export class EmptyStateComponent {
  private readonly loader = inject(CatbeeLoaderService);

  readonly icon = input.required<string>();
  readonly message = input.required<string>();
  readonly hint = input<string>();
  readonly size = input<'small' | 'medium' | 'large'>('medium');
  readonly showLoader = input(false);

  readonly emptyStateLoaderName = window.crypto.randomUUID();

  constructor() {
    effect(() => {
      const message = this.message();
      const visible = this.showLoader();

      untracked(() => {
        if (visible) {
          void this.loader.show(this.emptyStateLoaderName, {
            message,
            fullscreen: false
          });
        } else {
          void this.loader.hide(this.emptyStateLoaderName);
        }
      });
    });
  }
}
