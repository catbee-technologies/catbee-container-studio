import { Component, ElementRef, inject, input, output, signal } from '@angular/core';

@Component({
  selector: 'catbee-container-studio-table-column-resizer',
  templateUrl: './table-column-resizer.html',
  styleUrl: './table-column-resizer.scss',
  host: {
    '[class.is-resizing]': 'isResizing()',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(pointercancel)': 'onPointerCancel($event)',
    '(dblclick)': 'onDoubleClick($event)',
    role: 'separator',
    'aria-orientation': 'vertical',
    tabindex: '-1'
  }
})
export class TableColumnResizerComponent {
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  readonly minWidth = input(60);
  readonly maxWidth = input(1000);
  readonly defaultWidth = input<number | null>(null);
  readonly currentWidth = input<number | null>(null);

  readonly widthChange = output<number>();
  readonly widthChangeEnd = output<number>();
  readonly resetWidth = output<void>();

  readonly isResizing = signal(false);

  private startX = 0;
  private startWidth = 0;
  private activeWidth = 0;

  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    event.preventDefault();

    const host = this.elementRef.nativeElement;
    host.setPointerCapture(event.pointerId);

    const th = host.closest('th') ?? host.parentElement;
    this.startX = event.clientX;
    const initialWidth = this.currentWidth() ?? (th ? th.getBoundingClientRect().width : 0);
    this.startWidth = Math.round(initialWidth);
    this.activeWidth = this.startWidth;
    this.isResizing.set(true);
    document.body.classList.add('table-column-resizing');
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.isResizing()) {
      return;
    }

    event.stopPropagation();
    event.preventDefault();

    const delta = event.clientX - this.startX;
    const rawWidth = Math.round(this.startWidth + delta);
    const clamped = Math.max(this.minWidth(), Math.min(this.maxWidth(), rawWidth));

    if (clamped !== this.activeWidth) {
      this.activeWidth = clamped;
      this.widthChange.emit(clamped);
    }
  }

  onPointerUp(event: PointerEvent): void {
    if (!this.isResizing()) {
      return;
    }

    event.stopPropagation();
    event.preventDefault();

    const host = this.elementRef.nativeElement;
    if (host.hasPointerCapture(event.pointerId)) {
      host.releasePointerCapture(event.pointerId);
    }

    this.isResizing.set(false);
    document.body.classList.remove('table-column-resizing');

    this.widthChangeEnd.emit(this.activeWidth);
  }

  onPointerCancel(event: PointerEvent): void {
    this.onPointerUp(event);
  }

  onDoubleClick(event: MouseEvent): void {
    event.stopPropagation();
    event.preventDefault();

    if (this.defaultWidth() !== null) {
      this.widthChange.emit(this.defaultWidth()!);
      this.widthChangeEnd.emit(this.defaultWidth()!);
    }
    this.resetWidth.emit();
  }
}
