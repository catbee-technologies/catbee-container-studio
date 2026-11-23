import { CommonModule } from '@angular/common';
import { Component, input } from '@angular/core';
import { CatbeeTooltip, TooltipPosition } from '@components/tooltip/tooltip.directive';

@Component({
  selector: 'catbee-container-studio-hint-tooltip',
  imports: [CommonModule, CatbeeTooltip],
  templateUrl: './hint-tooltip.html',
  styleUrl: './hint-tooltip.scss'
})
export class HintTooltipComponent {
  readonly text = input.required<string>();
  readonly ariaLabel = input<string>('More information');
  readonly position = input<TooltipPosition>('top');
  readonly icon = input<string>('help');
}
