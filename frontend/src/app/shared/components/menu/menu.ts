import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, inject, input, output } from '@angular/core';

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
