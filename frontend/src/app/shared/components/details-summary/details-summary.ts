import { Component, input, output } from '@angular/core';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';

export interface DetailsSummaryItem {
  label: string;
  value: string;
  badge?: boolean;
}

@Component({
  selector: 'catbee-container-studio-details-summary',
  imports: [CopyButtonComponent, CatbeeTooltip],
  templateUrl: './details-summary.html',
  styleUrl: './details-summary.scss',
  host: {
    '[attr.title]': 'null'
  }
})
export class DetailsSummaryComponent {
  readonly title = input.required<string>();
  readonly resourceType = input.required<string>();
  readonly backLabel = input.required<string>();
  readonly identifier = input('');
  readonly size = input('');
  readonly items = input<readonly DetailsSummaryItem[]>([]);
  readonly back = output<void>();
}
