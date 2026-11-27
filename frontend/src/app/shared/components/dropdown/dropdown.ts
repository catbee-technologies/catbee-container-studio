import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  booleanAttribute,
  computed,
  effect,
  input,
  model,
  output,
  signal,
  viewChild
} from '@angular/core';
import { FormValueControl } from '@angular/forms/signals';
import { MenuComponent } from '@components/menu/menu';

export interface DropdownOption<T = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly disabled?: boolean;
}

@Component({
  selector: 'catbee-container-studio-dropdown',
  imports: [CommonModule, MenuComponent],
  templateUrl: './dropdown.html',
  styleUrl: './dropdown.scss',
  host: {
    '[style.width]': 'width() || null',
    '[style.max-width]': 'width() || null'
  }
})
export class DropdownComponent<T = string> implements FormValueControl<T> {
  private static nextId = 0;
  private readonly triggerBtn = viewChild<ElementRef<HTMLButtonElement>>('triggerBtn');

  readonly listboxId = `catbee-dropdown-listbox-${DropdownComponent.nextId++}`;

  readonly options = input.required<readonly DropdownOption<T>[]>();
  readonly value = model.required<T>();
  readonly placeholder = input('Select an option');
  readonly disabled = input(false);
  readonly inputId = input<string>();
  readonly labelClickOpen = input(false, { transform: booleanAttribute });
  readonly ariaLabel = input<string>();
  readonly ariaLabelledBy = input<string>();
  readonly alignment = input<'start' | 'end'>('start');
  readonly width = input<string>();
  readonly maxHeight = input('16rem');
  readonly compact = input(false, { transform: booleanAttribute });

  readonly touch = output<void>();

  readonly isOpen = signal(false);
  readonly activeIndex = signal(-1);
  readonly activeOptionId = computed(() => {
    const index = this.activeIndex();
    return this.isOpen() && this.options()[index] ? this.optionId(index) : null;
  });
  private readonly triggerWidth = signal<number | null>(null);
  private searchText = '';
  private lastSearchTime = 0;

  readonly triggerId = computed(() => {
    return this.labelClickOpen() ? this.inputId() || null : null;
  });

  readonly selectedOption = computed(() => {
    const current = this.value();
    return this.options().find(opt => opt.value === current);
  });

  readonly selectedLabel = computed(() => {
    return this.selectedOption()?.label ?? this.placeholder();
  });

  readonly menuStyle = computed(() => {
    const triggerWidth = this.triggerWidth();
    const customWidth = this.width();
    const widthVal = customWidth || (triggerWidth ? `${triggerWidth}px` : undefined);

    const style: Record<string, string> = {
      'box-sizing': 'border-box',
      'max-height': this.maxHeight()
    };

    if (widthVal) {
      style['width'] = widthVal;
      style['max-width'] = widthVal;
    }

    return style;
  });

  constructor() {
    effect(() => {
      if (this.disabled()) this.close();
    });
  }

  onTriggerClick(event: MouseEvent): void {
    if (this.disabled()) return;

    if (!this.labelClickOpen()) {
      // 1. Synthetic click dispatched by an associated <label for="..."> click has detail === 0
      if (event.detail === 0) {
        return;
      }

      // 2. Click originated outside the dropdown trigger button (e.g. mouse clicked directly on <label>)
      const trigger = this.triggerBtn()?.nativeElement;
      if (trigger) {
        const rect = trigger.getBoundingClientRect();
        const isInside =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom;
        if (!isInside) {
          return;
        }
      }
    }

    this.toggle();
  }

  toggle(): void {
    if (this.disabled()) return;
    const next = !this.isOpen();
    if (next) {
      this.open();
    } else {
      this.close();
    }
  }

  open(): void {
    if (this.disabled() || this.isOpen()) return;
    this.measureWidth();
    this.syncActiveIndex();
    this.isOpen.set(true);
    this.scrollToActive();
  }

  close(): void {
    this.isOpen.set(false);
    this.activeIndex.set(-1);
    this.searchText = '';
  }

  selectOption(option: DropdownOption<T>): void {
    if (option.disabled || this.disabled()) return;
    this.value.set(option.value);
    this.close();
    this.focus({ preventScroll: true });
  }

  focus(options?: FocusOptions): void {
    this.triggerBtn()?.nativeElement.focus(options);
  }

  optionId(index: number): string {
    return `${this.listboxId}-option-${index}`;
  }

  isSelected(val: T): boolean {
    return this.value() === val;
  }

  onKeyDown(event: KeyboardEvent): void {
    if (this.disabled()) return;

    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        this.handleEnterOrSpace();
        break;

      case 'ArrowDown':
        event.preventDefault();
        this.handleArrow(1);
        break;

      case 'ArrowUp':
        event.preventDefault();
        this.handleArrow(-1);
        break;

      case 'Home':
      case 'End':
        event.preventDefault();
        this.open();
        this.moveActive(event.key === 'Home' ? 1 : -1, -1);
        break;

      case 'Escape':
        if (this.isOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.close();
        }
        break;

      case 'Tab':
        if (this.isOpen()) {
          this.close();
        }
        break;

      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          this.searchOptions(event.key, event.timeStamp);
        }
    }
  }

  private handleEnterOrSpace(): void {
    if (!this.isOpen()) {
      this.open();
      return;
    }
    const idx = this.activeIndex();
    const option = this.options()[idx];
    if (option && !option.disabled) {
      this.selectOption(option);
    } else {
      this.close();
    }
  }

  private handleArrow(delta: 1 | -1): void {
    if (!this.isOpen()) {
      this.open();
      if (delta === -1 && !this.selectedOption()) {
        this.moveActive(-1, -1);
      }
    } else {
      this.moveActive(delta);
    }
  }

  private measureWidth(): void {
    const trigger = this.triggerBtn()?.nativeElement;
    if (trigger) {
      this.triggerWidth.set(trigger.getBoundingClientRect().width);
    }
  }

  private syncActiveIndex(): void {
    const current = this.value();
    const options = this.options();
    const index = options.findIndex(option => !option.disabled && option.value === current);
    this.activeIndex.set(index === -1 ? options.findIndex(option => !option.disabled) : index);
  }

  private moveActive(delta: 1 | -1, start = this.activeIndex()): void {
    const options = this.options();
    const from = start === -1 && delta === -1 ? 0 : start;
    for (const [step] of options.entries()) {
      const index = (from + (step + 1) * delta + options.length) % options.length;
      if (!options[index].disabled) {
        this.activeIndex.set(index);
        this.scrollToActive();
        return;
      }
    }
  }

  private searchOptions(key: string, time: number): void {
    this.open();
    const letter = key.toLocaleLowerCase();
    const previous = time - this.lastSearchTime < 500 ? this.searchText : '';
    const repeat = previous === letter;
    this.searchText = repeat ? letter : previous + letter;
    this.lastSearchTime = time;

    const options = this.options();
    const start = repeat ? this.activeIndex() + 1 : 0;
    for (let offset = 0; offset < options.length; offset++) {
      const index = (start + offset) % options.length;
      const option = options[index];
      if (!option.disabled && option.label.toLocaleLowerCase().startsWith(this.searchText)) {
        this.activeIndex.set(index);
        this.scrollToActive();
        return;
      }
    }
  }

  private scrollToActive(): void {
    requestAnimationFrame(() => {
      if (!this.isOpen()) return;
      const listEl = document.getElementById(this.listboxId);
      if (!listEl) return;
      const items = listEl.querySelectorAll<HTMLElement>('.catbee-dropdown-item');
      const activeEl = items[this.activeIndex()];
      if (activeEl) {
        this.centerItemInContainer(activeEl);
      }
    });
  }

  private centerItemInContainer(targetItem: HTMLElement): void {
    const scrollContainer = targetItem.closest<HTMLElement>('.options-menu');
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();
      const itemRect = targetItem.getBoundingClientRect();
      const currentScrollTop = scrollContainer.scrollTop;

      // Distance from container top to item center
      const itemCenterOffset = itemRect.top - containerRect.top + itemRect.height / 2;
      const containerCenter = containerRect.height / 2;
      const targetScrollTop = currentScrollTop + (itemCenterOffset - containerCenter);

      const maxScroll = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      scrollContainer.scrollTop = Math.max(0, Math.min(maxScroll, targetScrollTop));
    } else {
      targetItem.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }
}
