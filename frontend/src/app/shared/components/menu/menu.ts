import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  TemplateRef,
  ViewContainerRef,
  booleanAttribute,
  effect,
  inject,
  input,
  output,
  viewChild
} from '@angular/core';
import { ConnectedPosition, Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import { MenuService } from './menu.service';

@Component({
  selector: 'catbee-container-studio-menu',
  imports: [CommonModule],
  templateUrl: './menu.html',
  styleUrl: './menu.scss'
})
export class MenuComponent implements OnDestroy {
  private readonly hostElementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly overlay = inject(Overlay);
  private readonly viewContainerRef = inject(ViewContainerRef);
  private readonly menuService = inject(MenuService);

  readonly open = input(false);
  readonly style = input<Record<string, string>>();
  readonly closeOnScroll = input(true, { transform: booleanAttribute });

  readonly dismissed = output<void>();

  private readonly menuId = Symbol();

  private readonly menuTemplate = viewChild.required<TemplateRef<unknown>>('menuTemplate');

  private overlayRef: OverlayRef | null = null;
  private menuPortal: TemplatePortal<unknown> | null = null;
  private scrollContainer: HTMLElement | null = null;

  private readonly positions: ConnectedPosition[] = [
    {
      originX: 'end',
      originY: 'bottom',
      overlayX: 'end',
      overlayY: 'top',
      offsetY: 6
    },
    {
      originX: 'end',
      originY: 'top',
      overlayX: 'end',
      overlayY: 'bottom',
      offsetY: -6
    }
  ];

  constructor() {
    effect(() => {
      if (this.open()) {
        this.menuService.register(this.menuId);
        this.openMenu();
      } else {
        this.closeMenu();
      }
    });

    effect(() => {
      if (!this.open()) {
        return;
      }

      if (!this.menuService.isActive(this.menuId)) {
        this.dismissed.emit();
      }
    });
  }

  private openMenu(): void {
    if (this.overlayRef) {
      return;
    }

    const trigger = this.hostElementRef.nativeElement.querySelector<HTMLElement>('[menuTrigger]');

    if (!trigger) {
      return;
    }

    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo(trigger)
      .withPositions(this.positions)
      .withFlexibleDimensions(false)
      .withPush(true)
      .withViewportMargin(8);

    this.overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.noop(),
      hasBackdrop: false,
      panelClass: 'catbee-menu-overlay-panel'
    });

    this.menuPortal = new TemplatePortal(this.menuTemplate(), this.viewContainerRef);

    this.overlayRef.attach(this.menuPortal);

    this.addScrollListener();

    this.overlayRef.keydownEvents().subscribe(event => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      this.dismissed.emit();
    });

    this.overlayRef.detachments().subscribe(() => {
      this.removeScrollListener();

      this.overlayRef = null;
      this.menuPortal = null;

      if (this.open()) {
        this.dismissed.emit();
      }
    });
  }

  private closeMenu(): void {
    this.removeScrollListener();

    this.overlayRef?.dispose();

    this.overlayRef = null;
    this.menuPortal = null;

    this.menuService.close(this.menuId);
  }

  private addScrollListener(): void {
    this.scrollContainer = this.findScrollContainer();

    this.scrollContainer?.addEventListener('scroll', this.handleScroll, {
      passive: true
    });
  }

  private removeScrollListener(): void {
    this.scrollContainer?.removeEventListener('scroll', this.handleScroll);
    this.scrollContainer = null;
  }

  private readonly handleScroll = (): void => {
    if (!this.open() || !this.overlayRef) {
      return;
    }

    if (this.closeOnScroll()) {
      this.dismissed.emit();
      return;
    }

    if (!this.isTriggerWithinScrollContainer()) {
      this.dismissed.emit();
      return;
    }

    this.overlayRef.updatePosition();
  };

  private isTriggerWithinScrollContainer(): boolean {
    const trigger = this.hostElementRef.nativeElement.querySelector<HTMLElement>('[menuTrigger]');

    if (!trigger || !this.scrollContainer) {
      return false;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const containerRect = this.scrollContainer.getBoundingClientRect();

    return (
      triggerRect.bottom > containerRect.top &&
      triggerRect.top < containerRect.bottom &&
      triggerRect.right > containerRect.left &&
      triggerRect.left < containerRect.right
    );
  }

  private findScrollContainer(): HTMLElement | null {
    let element: HTMLElement | null = this.hostElementRef.nativeElement;

    while (element) {
      const style = getComputedStyle(element);
      const canScrollVertically =
        ['auto', 'scroll', 'overlay'].includes(style.overflowY) && element.scrollHeight > element.clientHeight;
      const canScrollHorizontally =
        ['auto', 'scroll', 'overlay'].includes(style.overflowX) && element.scrollWidth > element.clientWidth;
      if (canScrollVertically || canScrollHorizontally) {
        return element;
      }
      element = element.parentElement;
    }

    return null;
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

    const trigger = this.hostElementRef.nativeElement.querySelector<HTMLElement>('[menuTrigger]');

    if (trigger?.contains(target)) {
      return;
    }

    if (this.overlayRef?.overlayElement.contains(target)) {
      return;
    }

    this.dismissed.emit();
  }

  ngOnDestroy(): void {
    this.closeMenu();
  }
}
