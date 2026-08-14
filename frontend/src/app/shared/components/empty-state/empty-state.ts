import { Component, input } from '@angular/core';

@Component({
  selector: 'catbee-container-studio-empty-state',
  templateUrl: './empty-state.html',
  styleUrls: ['./empty-state.scss'],
  host: {
    height: '100%'
  }
})
export class EmptyStateComponent {
  readonly icon = input.required<string>();
  readonly message = input.required<string>();
  readonly hint = input<string>();
}
