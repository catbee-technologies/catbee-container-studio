import { CommonModule } from '@angular/common';
import { Component, ElementRef, input, output, viewChild } from '@angular/core';

@Component({
  selector: 'catbee-container-studio-search-input',
  imports: [CommonModule],
  templateUrl: './search-input.html',
  styleUrl: './search-input.scss'
})
export class SearchInputComponent {
  readonly value = input('');
  readonly inputId = input('');
  readonly type = input<'text' | 'search'>('text');
  readonly placeholder = input('Search');
  readonly ariaLabel = input('Search');
  readonly width = input('min(360px, 100%)');

  readonly valueChange = output<string>();
  readonly inputKeydown = output<KeyboardEvent>();

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  onInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.valueChange.emit((target?.value ?? '').toString());
  }

  onKeydown(event: KeyboardEvent): void {
    this.inputKeydown.emit(event);
  }

  clear(): void {
    this.valueChange.emit('');
    this.focus();
  }

  focus(): void {
    this.searchInput()?.nativeElement.focus();
  }

  focusAndSelect(): void {
    const input = this.searchInput()?.nativeElement;
    input?.focus();
    input?.select();
  }
}
