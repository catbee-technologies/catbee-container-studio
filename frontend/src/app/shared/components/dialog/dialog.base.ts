import { Directive, OnDestroy, TemplateRef, ViewContainerRef, inject } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';

@Directive()
export abstract class DialogOverlayBase implements OnDestroy {
  protected readonly overlay = inject(Overlay);
  protected readonly viewContainerRef = inject(ViewContainerRef);

  private overlayRef: OverlayRef | null = null;
  private dialogPortal: TemplatePortal<unknown> | null = null;

  protected readonly closeAnimationDuration = 120;
  protected abstract onOverlayCancel(): void;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  protected openDialogOverlay(dialogTemplate: TemplateRef<unknown>): void {
    if (this.overlayRef) {
      return;
    }

    const positionStrategy = this.overlay.position().global().centerHorizontally().centerVertically();

    this.overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.block(),
      hasBackdrop: true,
      backdropClass: 'catbee-dialog-backdrop',
      panelClass: this.getPanelClass()
    });

    this.dialogPortal = new TemplatePortal(dialogTemplate, this.viewContainerRef);

    this.overlayRef.attach(this.dialogPortal);

    this.overlayRef.backdropClick().subscribe(() => {
      this.onOverlayCancel();
    });

    this.overlayRef.keydownEvents().subscribe(event => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      this.onOverlayCancel();
    });

    this.overlayRef.detachments().subscribe(() => {
      this.overlayRef = null;
      this.dialogPortal = null;
    });
  }

  protected closeDialogOverlay(): void {
    const overlayRef = this.overlayRef;

    if (!overlayRef) {
      return;
    }

    const dialog = overlayRef.overlayElement.querySelector<HTMLElement>('.catbee-dialog');
    const backdrop = overlayRef.backdropElement;

    dialog?.classList.add('closing');
    backdrop?.classList.add('catbee-dialog-backdrop-closing');

    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;

      if (this.overlayRef === overlayRef) {
        overlayRef.dispose();
        this.overlayRef = null;
        this.dialogPortal = null;
      }
    }, this.closeAnimationDuration);
  }

  protected getPanelClass(): string {
    return 'catbee-dialog-overlay-panel';
  }

  ngOnDestroy(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.overlayRef?.dispose();
    this.overlayRef = null;
    this.dialogPortal = null;
  }
}
