import { CommonModule } from '@angular/common';
import { Component, effect, ElementRef, HostListener, inject, input, output, signal } from '@angular/core';

type MenuPlacement = 'top' | 'bottom';

@Component({
  selector: 'catbee-container-studio-menu',
  imports: [CommonModule],
  templateUrl: './menu.html',
  styleUrl: './menu.scss'
})
export class MenuComponent {
  readonly open = input(false);
  readonly minWidth = input('10rem');

  readonly dismissed = output<void>();

  private readonly hostElementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly placement = signal<MenuPlacement>('bottom');

  constructor() {
    effect(() => {
      if (this.open()) {
        queueMicrotask(() => this.updatePlacement());
      }
    });
  }

  private updatePlacement(): void {
    const host = this.hostElementRef.nativeElement;
    const menu = host.querySelector<HTMLElement>('.options-menu');

    if (!menu) {
      return;
    }

    const trigger = host.querySelector<HTMLElement>('[menuTrigger]');

    if (!trigger) {
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const menuHeight = menu.getBoundingClientRect().height;

    const gap = 0.35 * 16;

    const spaceAbove = triggerRect.top;
    const spaceBelow = window.innerHeight - triggerRect.bottom;

    if (spaceBelow >= menuHeight + gap) {
      this.placement.set('bottom');
      return;
    }

    if (spaceAbove >= menuHeight + gap) {
      this.placement.set('top');
      return;
    }

    this.placement.set(spaceAbove > spaceBelow ? 'top' : 'bottom');
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMousedown(event: MouseEvent): void {
    if (!this.open()) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }

    if (!this.hostElementRef.nativeElement.contains(target)) {
      this.dismissed.emit();
    }
  }

  @HostListener('window:keydown', ['$event'])
  onWindowKeydown(event: KeyboardEvent): void {
    if (!this.open() || event.key !== 'Escape') {
      return;
    }

    this.dismissed.emit();
  }
}
