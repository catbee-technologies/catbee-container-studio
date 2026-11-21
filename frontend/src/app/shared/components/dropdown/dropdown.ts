import { CommonModule } from '@angular/common';
import { Component, ElementRef, booleanAttribute, computed, input, output, signal, viewChild } from '@angular/core';
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
  standalone: true,
  imports: [CommonModule, MenuComponent],
  templateUrl: './dropdown.html',
  styleUrl: './dropdown.scss',
  host: {
    '[style.width]': 'width() || null',
    '[style.max-width]': 'width() || null'
  }
})
export class DropdownComponent<T = string> {
  private static nextId = 0;
  private readonly triggerBtn = viewChild<ElementRef<HTMLButtonElement>>('triggerBtn');

  readonly listboxId = `catbee-dropdown-listbox-${DropdownComponent.nextId++}`;

  readonly options = input.required<readonly DropdownOption<T>[]>();
  readonly value = input<T>();
  readonly placeholder = input('Select an option');
  readonly disabled = input(false);
  readonly inputId = input<string>();
  readonly labelClickOpen = input(false, { transform: booleanAttribute });
  readonly ariaLabel = input<string>();
  readonly ariaLabelledBy = input<string>();
  readonly alignment = input<'start' | 'end'>('start');
  readonly width = input<string>();
  readonly maxHeight = input('16rem');

  readonly valueChange = output<T>();

  readonly isOpen = signal(false);
  readonly activeIndex = signal(-1);
  private readonly triggerWidth = signal<number | null>(null);

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
    this.scrollToSelected();
  }

  close(): void {
    this.isOpen.set(false);
    this.activeIndex.set(-1);
  }

  selectOption(option: DropdownOption<T>): void {
    if (option.disabled || this.disabled()) return;
    this.valueChange.emit(option.value);
    this.close();
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

      case 'Escape':
        if (this.isOpen()) {
          event.preventDefault();
          this.close();
        }
        break;

      case 'Tab':
        if (this.isOpen()) {
          this.close();
        }
        break;
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
    const idx = this.options().findIndex(opt => opt.value === current);
    this.activeIndex.set(idx);
  }

  private moveActive(delta: number): void {
    const opts = this.options();
    if (opts.length === 0) return;
    let currentIdx = this.activeIndex();
    if (currentIdx === -1) {
      const selected = this.options().findIndex(opt => opt.value === this.value());
      if (selected >= 0) {
        currentIdx = selected;
      } else {
        currentIdx = delta > 0 ? -1 : 0;
      }
    }
    let next = currentIdx + delta;
    if (next < 0) next = opts.length - 1;
    if (next >= opts.length) next = 0;
    this.activeIndex.set(next);
    this.scrollToActive();
  }

  private scrollToSelected(): void {
    setTimeout(() => {
      if (!this.isOpen()) return;
      const listEl = document.getElementById(this.listboxId);
      if (!listEl) return;
      const targetItem =
        listEl.querySelector<HTMLElement>('.catbee-dropdown-item.is-selected') ||
        listEl.querySelectorAll<HTMLElement>('.catbee-dropdown-item')[this.activeIndex()];
      if (targetItem) {
        this.centerItemInContainer(targetItem);
      }
    }, 30);
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
