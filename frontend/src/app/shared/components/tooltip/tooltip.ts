import { CommonModule } from '@angular/common';
import { Component, TemplateRef, computed, input } from '@angular/core';
import { Position } from './tooltip.directive';

@Component({
  selector: 'catbee-tooltip-content',
  imports: [CommonModule],
  host: {
    class: 'catbee-tooltip'
  },
  template: `
    @if (templateContent(); as template) {
      <ng-container [ngTemplateOutlet]="template" />
    } @else {
      {{ textContent() }}
    }

    <div
      class="catbee-tooltip-arrow"
      [class.top]="position() === Position.TOP"
      [class.bottom]="position() === Position.BOTTOM"
      [class.left]="position() === Position.LEFT"
      [class.right]="position() === Position.RIGHT"
      aria-hidden="true"
    ></div>
  `
})
export class Tooltip {
  readonly Position = Position;

  readonly content = input<string | TemplateRef<unknown>>();
  readonly position = input<Position>(Position.TOP);

  readonly templateContent = computed(() => {
    const value = this.content();
    return value instanceof TemplateRef ? value : null;
  });

  readonly textContent = computed(() => {
    const value = this.content();
    return typeof value === 'string' ? value : '';
  });
}
