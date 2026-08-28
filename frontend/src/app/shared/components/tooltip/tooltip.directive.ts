import { isPlatformBrowser } from '@angular/common';
import {
  booleanAttribute,
  Directive,
  ElementRef,
  effect,
  inject,
  input,
  OnDestroy,
  PLATFORM_ID,
  TemplateRef,
  ViewContainerRef,
  ComponentRef
} from '@angular/core';
import { ConnectedPosition, Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { Tooltip } from './tooltip';

export enum Position {
  TOP = 'top',
  BOTTOM = 'bottom',
  LEFT = 'left',
  RIGHT = 'right'
}

export type TooltipPosition = `${Position}`;
export type TooltipEvent = 'hover' | 'focus' | 'click';

@Directive({
  selector: '[catbeeTooltip]',
  standalone: true
})
export class CatbeeTooltip implements OnDestroy {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly overlay = inject(Overlay);
  private readonly viewContainerRef = inject(ViewContainerRef);
  private readonly platformId = inject(PLATFORM_ID);

  readonly catbeeTooltip = input<string | TemplateRef<unknown>>();
  readonly catbeeTooltipPosition = input<TooltipPosition>(Position.BOTTOM);
  readonly catbeeTooltipDelay = input<number>(0);
  readonly catbeeTooltipClass = input<string>('catbee-tooltip');
  readonly catbeeTooltipDisabled = input(false, { transform: booleanAttribute });
  readonly catbeeTooltipEvent = input<TooltipEvent>('hover');

  private overlayRef: OverlayRef | null = null;
  private showTimeout?: ReturnType<typeof setTimeout>;
  private cleanupFns: (() => void)[] = [];
  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;
  private tooltipComponentRef: ComponentRef<Tooltip> | null = null;

  private readonly positions: Record<Position, ConnectedPosition> = {
    [Position.TOP]: {
      originX: 'center',
      originY: 'top',
      overlayX: 'center',
      overlayY: 'bottom',
      offsetY: -8
    },
    [Position.BOTTOM]: {
      originX: 'center',
      originY: 'bottom',
      overlayX: 'center',
      overlayY: 'top',
      offsetY: 8
    },
    [Position.LEFT]: {
      originX: 'start',
      originY: 'center',
      overlayX: 'end',
      overlayY: 'center',
      offsetX: -8
    },
    [Position.RIGHT]: {
      originX: 'end',
      originY: 'center',
      overlayX: 'start',
      overlayY: 'center',
      offsetX: 8
    }
  };
  private readonly fallbackOrder: Position[] = [Position.TOP, Position.BOTTOM, Position.RIGHT, Position.LEFT];

  constructor() {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    effect(() => {
      this.removeListeners();
      if (this.catbeeTooltipDisabled()) {
        this.hideTooltip();
        return;
      }
      this.addListeners();
    });

    effect(() => {
      const content = this.catbeeTooltip();
      if (!this.tooltipComponentRef) {
        return;
      }
      if (content == null || content === '') {
        this.hideTooltip();
        return;
      }
      this.tooltipComponentRef.setInput('content', content);
      requestAnimationFrame(() => {
        this.overlayRef?.updatePosition();
      });
    });
  }

  private addListeners(): void {
    const element = this.el.nativeElement;
    const event = this.catbeeTooltipEvent();

    const listen = (type: string, handler: EventListener): void => {
      element.addEventListener(type, handler);

      this.cleanupFns.push(() => {
        element.removeEventListener(type, handler);
      });
    };

    switch (event) {
      case 'hover':
        listen('pointerenter', this.handlePointerEnter);
        listen('pointermove', this.handlePointerMove);
        listen('pointerleave', this.handlePointerLeave);
        break;

      case 'focus':
        listen('focus', this.showTooltip);
        listen('blur', this.hideTooltip);
        break;

      case 'click':
        listen('click', this.toggleTooltip);
        break;
    }

    listen('keydown', this.handleEscape);
    document.addEventListener('scroll', this.handleScroll, true);
    this.cleanupFns.push(() => {
      document.removeEventListener('scroll', this.handleScroll, true);
    });
  }

  private removeListeners(): void {
    this.cleanupFns.forEach(cleanup => cleanup());
    this.cleanupFns = [];
  }

  private readonly showTooltip = (): void => {
    const content = this.catbeeTooltip();

    if (this.catbeeTooltipDisabled() || content == null || content === '') {
      return;
    }

    this.clearTimer();

    const delay = this.catbeeTooltipDelay();

    if (delay > 0) {
      this.showTimeout = setTimeout(() => {
        this.showTimeout = undefined;

        if (this.catbeeTooltipDisabled()) {
          return;
        }

        this.createTooltip();
      }, delay);

      return;
    }

    this.createTooltip();
  };

  private readonly hideTooltip = (): void => {
    this.clearTimer();
    this.destroyTooltip();
  };

  private readonly toggleTooltip = (): void => {
    if (this.overlayRef) {
      this.hideTooltip();
      return;
    }

    this.showTooltip();
  };

  private readonly handleEscape = (event: Event): void => {
    if ((event as KeyboardEvent).key !== 'Escape') {
      return;
    }

    event.preventDefault();
    this.hideTooltip();
  };

  private readonly clearTimer = (): void => {
    if (!this.showTimeout) {
      return;
    }

    clearTimeout(this.showTimeout);
    this.showTimeout = undefined;
  };

  private readonly createTooltip = (): void => {
    if (this.overlayRef) {
      return;
    }

    const preferred = this.catbeeTooltipPosition();

    const positions = [preferred, ...this.fallbackOrder.filter(position => position !== preferred)];

    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo(this.el)
      .withPositions(positions.map(position => this.positions[position]))
      .withFlexibleDimensions(false)
      .withPush(true)
      .withViewportMargin(8);

    this.overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      hasBackdrop: false,
      panelClass: 'catbee-tooltip-overlay-panel'
    });

    const portal = new ComponentPortal(Tooltip, this.viewContainerRef);

    const componentRef = this.overlayRef.attach(portal);
    this.tooltipComponentRef = componentRef;

    componentRef.setInput('content', this.catbeeTooltip());
    componentRef.setInput('position', preferred);
    this.overlayRef.updatePosition();

    const tooltip = componentRef.location.nativeElement as HTMLElement;

    const tooltipClasses = this.catbeeTooltipClass().split(/\s+/).filter(Boolean);

    tooltip.classList.add(...tooltipClasses);

    const tooltipId = `catbee-tooltip-${crypto.randomUUID().replace(/-/g, '')}`;

    tooltip.id = tooltipId;

    this.el.nativeElement.setAttribute('aria-describedby', tooltipId);

    // CDK tells us which fallback position was actually selected.
    positionStrategy.positionChanges.subscribe(change => {
      componentRef.setInput('position', this.getPosition(change.connectionPair));
    });

    requestAnimationFrame(() => {
      if (!this.overlayRef) {
        return;
      }
      this.overlayRef.updatePosition();
      tooltip.classList.add('catbee-tooltip-visible');
    });
  };

  private getPosition(connection: ConnectedPosition): Position {
    if (connection.originY === 'top' && connection.overlayY === 'bottom') {
      return Position.TOP;
    }

    if (connection.originY === 'bottom' && connection.overlayY === 'top') {
      return Position.BOTTOM;
    }

    if (connection.originX === 'start' && connection.overlayX === 'end') {
      return Position.LEFT;
    }

    return Position.RIGHT;
  }

  private readonly handlePointerEnter = (event: Event): void => {
    const pointerEvent = event as PointerEvent;

    this.pointerX = pointerEvent.clientX;
    this.pointerY = pointerEvent.clientY;
    this.pointerInside = true;

    this.showTooltip();
  };

  private readonly handlePointerMove = (event: Event): void => {
    const pointerEvent = event as PointerEvent;

    this.pointerX = pointerEvent.clientX;
    this.pointerY = pointerEvent.clientY;
  };

  private readonly handlePointerLeave = (): void => {
    this.pointerInside = false;
    this.hideTooltip();
  };

  private readonly handleScroll = (): void => {
    if (!this.overlayRef || !this.pointerInside) {
      return;
    }

    const rect = this.el.nativeElement.getBoundingClientRect();

    const inside =
      this.pointerX >= rect.left &&
      this.pointerX <= rect.right &&
      this.pointerY >= rect.top &&
      this.pointerY <= rect.bottom;

    if (!inside) {
      this.pointerInside = false;
      this.hideTooltip();
      return;
    }

    this.overlayRef.updatePosition();
  };

  private destroyTooltip(): void {
    if (!this.overlayRef) {
      return;
    }

    this.overlayRef.dispose();
    this.overlayRef = null;
    this.tooltipComponentRef = null;

    this.el.nativeElement.removeAttribute('aria-describedby');
  }

  ngOnDestroy(): void {
    this.removeListeners();
    this.clearTimer();
    this.destroyTooltip();
  }
}
