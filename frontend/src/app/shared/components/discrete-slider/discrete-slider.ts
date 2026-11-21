import { CommonModule } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';

export interface DiscreteSliderLabel {
  value: number;
  label: string;
}

@Component({
  selector: 'catbee-container-studio-discrete-slider',
  imports: [CommonModule],
  templateUrl: './discrete-slider.html',
  styleUrl: './discrete-slider.scss'
})
export class DiscreteSliderComponent {
  readonly min = input<number>(0);
  readonly max = input<number>(12);
  readonly step = input<number>(1);
  readonly value = input<number>(0);
  readonly disabled = input<boolean>(false);
  readonly totalTicks = input<number>();
  readonly majorTickInterval = input<number>(3);
  readonly labels = input<DiscreteSliderLabel[]>([]);
  readonly ariaLabel = input<string>('Discrete slider');

  readonly valueChange = output<number>();

  readonly computedTotalTicks = computed(() => {
    const custom = this.totalTicks();
    if (custom !== undefined && custom > 0) return custom;
    const minVal = this.min();
    const maxVal = this.max();
    const stepVal = this.step() || 1;
    if (maxVal <= minVal) return 1;
    return Math.floor((maxVal - minVal) / stepVal) + 1;
  });

  readonly fillPercent = computed(() => {
    const minVal = this.min();
    const maxVal = this.max();
    const curVal = this.value();
    if (maxVal <= minVal) return 0;
    const pct = ((curVal - minVal) / (maxVal - minVal)) * 100;
    return Math.max(0, Math.min(100, pct));
  });

  readonly ticksList = computed(() => {
    const count = this.computedTotalTicks();
    const majorInt = this.majorTickInterval();
    const curVal = this.value();
    const minVal = this.min();
    const stepVal = this.step();
    return Array.from({ length: count }, (_, i) => {
      const val = minVal + i * stepVal;
      return {
        index: i,
        value: val,
        isMajor: majorInt > 0 ? i % majorInt === 0 : false,
        isActive: val <= curVal
      };
    });
  });

  onInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const num = Number(target.value);
    this.valueChange.emit(num);
  }

  onTickClick(value: number): void {
    if (this.disabled()) return;
    this.valueChange.emit(value);
  }
}
