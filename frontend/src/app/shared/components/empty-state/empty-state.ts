import { Component, input } from '@angular/core';
import { CatbeeLoaderComponent, CatbeeLoaderSize } from '@ng-catbee/loader';

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
  readonly icon = input.required<string>();
  readonly message = input.required<string>();
  readonly hint = input<string>();
  readonly size = input<'small' | 'medium' | 'large'>('medium');
  readonly showLoader = input(false);
  readonly loaderSize = input<CatbeeLoaderSize>('default');

  readonly emptyStateLoaderName = window.crypto.randomUUID();
}
