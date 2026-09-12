import { CommonModule } from '@angular/common';
import {
  afterNextRender,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
  signal,
  viewChild,
  viewChildren
} from '@angular/core';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
}

interface IndicatorGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  visible: boolean;
}

@Component({
  selector: 'catbee-container-studio-tabs',
  imports: [CommonModule],
  templateUrl: './tabs.html',
  styleUrl: './tabs.scss'
})
export class TabsComponent {
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = input.required<readonly TabItem[]>();
  readonly activeTab = input.required<string>();
  readonly ariaLabel = input.required<string>();

  readonly activeTabChange = output<string>();

  readonly trackElement = viewChild<ElementRef<HTMLElement>>('trackElement');
  readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabBtn');

  readonly indicatorStyle = signal<IndicatorGeometry>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    visible: false
  });

  readonly isAnimated = signal(false);

  constructor() {
    effect(() => {
      this.activeTab();
      this.tabs();
      queueMicrotask(() => this.updateIndicatorForTab(this.activeTab()));
    });

    afterNextRender(() => {
      this.updateIndicatorForTab(this.activeTab());
      this.setupResizeObserver();
    });
  }

  selectTab(tabId: string): void {
    if (tabId === this.activeTab()) {
      return;
    }
    this.updateIndicatorForTab(tabId);
    this.activeTabChange.emit(tabId);
  }

  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const tabList = this.tabs();
    if (!tabList.length) {
      return;
    }

    const currentIndex = tabList.findIndex(t => t.id === this.activeTab());
    let newIndex = -1;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      newIndex = (currentIndex + 1) % tabList.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      newIndex = (currentIndex - 1 + tabList.length) % tabList.length;
    } else if (event.key === 'Home') {
      newIndex = 0;
    } else if (event.key === 'End') {
      newIndex = tabList.length - 1;
    }

    if (newIndex >= 0 && newIndex !== currentIndex) {
      event.preventDefault();
      const nextTab = tabList[newIndex];
      this.selectTab(nextTab.id);

      const targetBtn = this.tabButtons().find(btn => btn.nativeElement.dataset['tabId'] === nextTab.id);
      targetBtn?.nativeElement.focus();
    }
  }

  private updateIndicatorForTab(tabId: string): void {
    const buttons = this.tabButtons();
    const track = this.trackElement()?.nativeElement;

    if (!track || !buttons || buttons.length === 0) {
      return;
    }

    const targetButton = buttons.find(btn => btn.nativeElement.dataset['tabId'] === tabId);

    if (!targetButton) {
      this.indicatorStyle.update(prev => ({ ...prev, visible: false }));
      return;
    }

    const btnEl = targetButton.nativeElement;
    const left = btnEl.offsetLeft;
    const top = btnEl.offsetTop;
    const width = btnEl.offsetWidth;
    const height = btnEl.offsetHeight;

    if (width === 0 && height === 0) {
      return;
    }

    this.indicatorStyle.set({
      left,
      top,
      width,
      height,
      visible: true
    });

    if (!this.isAnimated()) {
      requestAnimationFrame(() => {
        this.isAnimated.set(true);
      });
    }
  }

  private setupResizeObserver(): void {
    const track = this.trackElement()?.nativeElement;
    if (!track || typeof ResizeObserver === 'undefined') {
      return;
    }

    const ro = new ResizeObserver(() => {
      this.updateIndicatorForTab(this.activeTab());
    });
    ro.observe(track);

    this.destroyRef.onDestroy(() => {
      ro.disconnect();
    });
  }
}
