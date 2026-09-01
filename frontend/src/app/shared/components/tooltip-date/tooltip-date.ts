import { DatePipe } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { DATE_FORMAT, formatDockerRelativeTime } from '@utils/docker-display.utils';

@Component({
  selector: 'catbee-container-studio-tooltip-date',
  imports: [CatbeeTooltip],
  template: `
    <span
      [catbeeTooltip]="formattedTooltipDate()"
      [catbeeTooltipDisabled]="!formattedTooltipDate()"
      [catbeeTooltipPosition]="'top'"
      [catbeeTooltipDelay]="tooltipDelay"
    >
      {{ content() }}
    </span>
  `
})
export class TooltipDateComponent {
  private readonly datePipe = inject(DatePipe);

  readonly date = input.required<string | null | undefined | Date>();
  readonly useRelativeContent = input(true);

  readonly formattedTooltipDate = computed(() => this.datePipe.transform(this.date(), DATE_FORMAT) ?? '');

  readonly content = computed(() => {
    const date = this.date();

    if (!date) {
      return '';
    }

    return this.useRelativeContent() ? formatDockerRelativeTime(date) : this.formattedTooltipDate();
  });

  readonly tooltipDelay = 300;
}
