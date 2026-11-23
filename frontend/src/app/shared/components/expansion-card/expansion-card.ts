import { Component, input, output } from '@angular/core';

@Component({
  selector: 'catbee-container-studio-expansion-card',
  templateUrl: './expansion-card.html',
  styleUrl: './expansion-card.scss',
  host: {
    '[attr.title]': 'null'
  }
})
export class ExpansionCardComponent {
  readonly expanded = input<boolean>(false);
  readonly title = input<string>('');
  readonly subtitle = input<string>('');
  readonly icon = input<string>('');
  readonly cardId = input<string>('');
  readonly headerClass = input<string>('');

  readonly expandedChange = output<boolean>();
  readonly toggled = output<void>();

  onHeaderClick(event?: Event): void {
    if (event) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, a, input, select, textarea, [expansion-actions]')) {
        return;
      }
    }
    this.toggled.emit();
    this.expandedChange.emit(!this.expanded());
  }

  onHeaderKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, a, input, select, textarea, [expansion-actions]')) {
        return;
      }
      event.preventDefault();
      this.toggled.emit();
      this.expandedChange.emit(!this.expanded());
    }
  }
}
