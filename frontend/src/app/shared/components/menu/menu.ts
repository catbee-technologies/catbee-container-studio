import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  OnDestroy,
  TemplateRef,
  ViewContainerRef,
  booleanAttribute,
  effect,
  inject,
  input,
  output,
  untracked,
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
  private readonly parentMenu = inject(MenuComponent, { optional: true, skipSelf: true });

  readonly open = input(false);
  readonly style = input<Record<string, string>>();
  readonly closeOnScroll = input(true, { transform: booleanAttribute });
  readonly focusOnOpen = input(false, { transform: booleanAttribute });
  readonly contentRole = input<'menu' | 'presentation'>('menu');
  readonly alignment = input<'start' | 'end'>('end');
  readonly placement = input<'bottom' | 'top'>('bottom');

  readonly dismissed = output<void>();

  private readonly menuId = Symbol();

  private readonly menuTemplate = viewChild.required<TemplateRef<unknown>>('menuTemplate');

  private overlayRef: OverlayRef | null = null;
  private menuPortal: TemplatePortal<unknown> | null = null;
  private scrollContainer: HTMLElement | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly closeAnimationDuration = 120;

  constructor() {
    effect(() => {
      const open = this.open();
      untracked(() => {
        if (open) {
          this.menuService.register(this.menuId, this.parentMenu?.menuId);
          this.openMenu();
        } else {
          this.closeMenu();
        }
      });
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
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
      const closingOverlay = this.overlayRef;
      this.overlayRef = null;
      this.menuPortal = null;
      closingOverlay?.dispose();
    }

    if (this.overlayRef) {
      return;
    }

    const trigger = this.hostElementRef.nativeElement.querySelector<HTMLElement>('[menuTrigger]');

    if (!trigger) {
      return;
    }

    const isStart = this.alignment() === 'start';
    const isTop = this.placement() === 'top';

    const originX: 'start' | 'end' = isStart ? 'start' : 'end';
    const overlayX: 'start' | 'end' = isStart ? 'start' : 'end';

    const bottomPos: ConnectedPosition = {
      originX,
      originY: 'bottom',
      overlayX,
      overlayY: 'top',
      offsetY: 6
    };

    const topPos: ConnectedPosition = {
      originX,
      originY: 'top',
      overlayX,
      overlayY: 'bottom',
      offsetY: -6
    };

    const positions: ConnectedPosition[] = isTop ? [topPos, bottomPos] : [bottomPos, topPos];

    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo(trigger)
      .withPositions(positions)
      .withFlexibleDimensions(false)
      .withPush(true)
      .withViewportMargin(8);

    const overlay = (this.overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.noop(),
      hasBackdrop: false,
      panelClass: 'catbee-menu-overlay-panel'
    }));
    this.overlayRef = overlay;

    this.menuPortal = new TemplatePortal(this.menuTemplate(), this.viewContainerRef);

    overlay.attach(this.menuPortal);

    this.addScrollListener();

    if (this.focusOnOpen()) {
      const focusable = overlay.overlayElement.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabIndex="0"]'
      );
      focusable?.focus({ preventScroll: true });
    }

    overlay.keydownEvents().subscribe(event => this.onContentKeydown(event));
    overlay.outsidePointerEvents().subscribe(event => {
      const target = event.target;
      if (!this.open() || !(target instanceof Node)) return;

      const label = target instanceof Element ? target.closest('label') : null;
      if (!trigger.contains(target) && label?.control !== trigger) {
        this.dismissed.emit();
      }
    });

    overlay.detachments().subscribe(() => {
      if (this.overlayRef !== overlay) return;
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
    this.menuService.close(this.menuId);

    if (!this.overlayRef) {
      return;
    }

    const overlay = this.overlayRef;
    const menuEl = overlay.overlayElement.querySelector<HTMLElement>('.options-menu');

    if (menuEl) {
      menuEl.classList.add('closing');
      this.closeTimer = setTimeout(() => {
        this.closeTimer = null;
        if (this.overlayRef === overlay) {
          overlay.dispose();
          this.overlayRef = null;
          this.menuPortal = null;
        }
      }, this.closeAnimationDuration);
    } else {
      overlay.dispose();
      this.overlayRef = null;
      this.menuPortal = null;
    }
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

  onContentKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.open() && this.menuService.isTopMost(this.menuId)) {
      event.preventDefault();
      event.stopPropagation();
      this.dismissed.emit();
      this.hostElementRef.nativeElement.querySelector<HTMLElement>('[menuTrigger]')?.focus({ preventScroll: true });
    }
  }

  ngOnDestroy(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.removeScrollListener();
    this.overlayRef?.dispose();
    this.overlayRef = null;
    this.menuPortal = null;
    this.menuService.close(this.menuId);
  }
}
