import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'catbee-k8s-icon',
  standalone: true,
  template: `
    <svg
      [style.width.px]="size()"
      [style.height.px]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      [attr.stroke-width]="strokeWidth()"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="k8s-svg-icon"
      aria-hidden="true"
    >
      <polygon points="12,4.8 17.6,7.5 19,13.6 15.1,18.5 8.9,18.5 5,13.6 6.4,7.5"></polygon>
      <circle cx="12" cy="12" r="2.5"></circle>
      <line x1="12" y1="9.5" x2="12" y2="2.2"></line>
      <line x1="13.9" y1="10.5" x2="19.7" y2="5.9"></line>
      <line x1="14.3" y1="12.5" x2="21.6" y2="14.2"></line>
      <line x1="13" y1="14.2" x2="16.3" y2="20.8"></line>
      <line x1="11" y1="14.2" x2="7.7" y2="20.8"></line>
      <line x1="9.7" y1="12.5" x2="2.4" y2="14.2"></line>
      <line x1="10.1" y1="10.5" x2="4.3" y2="5.9"></line>
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      vertical-align: middle;
      flex-shrink: 0;
    }

    .k8s-svg-icon {
      display: block;
      transition: color 0.15s ease;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class K8sIconComponent {
  readonly size = input<number>(16);
  readonly strokeWidth = input<number>(1.6);
}
