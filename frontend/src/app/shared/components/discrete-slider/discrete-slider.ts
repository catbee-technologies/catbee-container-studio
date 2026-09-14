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
  readonly totalTicks = input<number>(13);
  readonly majorTickInterval = input<number>(3);
  readonly labels = input<DiscreteSliderLabel[]>([]);
  readonly ariaLabel = input<string>('Discrete slider');

  readonly valueChange = output<number>();

  readonly fillPercent = computed(() => {
    const minVal = this.min();
    const maxVal = this.max();
    const curVal = this.value();
    if (maxVal <= minVal) return 0;
    const pct = ((curVal - minVal) / (maxVal - minVal)) * 100;
    return Math.max(0, Math.min(100, pct));
  });

  readonly ticksList = computed(() => {
    const count = this.totalTicks();
    const majorInt = this.majorTickInterval();
    const curVal = this.value();
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      isMajor: majorInt > 0 ? i % majorInt === 0 : false,
      isActive: i <= curVal
    }));
  });

  onInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const num = Number(target.value);
    this.valueChange.emit(num);
  }

  onTickClick(index: number): void {
    if (this.disabled()) return;
    this.valueChange.emit(index);
  }
}
