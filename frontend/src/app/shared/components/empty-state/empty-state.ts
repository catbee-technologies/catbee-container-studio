import { Component, effect, inject, input, untracked } from '@angular/core';
import { CatbeeLoaderComponent, CatbeeLoaderService } from '@ng-catbee/loader';
import { ThemeService } from '@services/theme.service';

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
  private readonly themeService = inject(ThemeService);

  readonly icon = input.required<string>();
  readonly message = input.required<string>();
  readonly hint = input<string>();
  readonly size = input<'small' | 'medium' | 'large'>('medium');
  readonly showLoader = input(false);
  readonly loaderColor = this.themeService.isLightMode.asReadonly();

  readonly emptyStateLoaderName = window.crypto.randomUUID();

  constructor() {
    effect(() => {
      const message = this.message();
      const visible = this.showLoader();
      const isLightMode = this.loaderColor();

      untracked(() => {
        queueMicrotask(() => {
          if (visible) {
            void this.loader.show(this.emptyStateLoaderName, {
              message,
              fullscreen: false,
              size: this.size() === 'large' ? 'medium' : this.size(),
              loaderColor: isLightMode ? '#087ea4' : '#d9f7ff'
            });
          } else {
            void this.loader.hide(this.emptyStateLoaderName);
          }
        });
      });
    });
  }
}
