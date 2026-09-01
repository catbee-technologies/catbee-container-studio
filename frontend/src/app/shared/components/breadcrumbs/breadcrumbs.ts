import { Component, computed, input, output } from '@angular/core';

export interface PathBreadcrumb {
  label: string;
  path: string;
}

@Component({
  selector: 'catbee-container-studio-breadcrumbs',
  templateUrl: './breadcrumbs.html',
  styleUrl: './breadcrumbs.scss'
})
export class BreadcrumbsComponent {
  readonly path = input.required<string>();
  readonly pathChange = output<string>();

  readonly breadcrumbs = computed<PathBreadcrumb[]>(() => {
    const parts = this.path().split('/').filter(Boolean);
    return [
      { label: 'Root', path: '/' },
      ...parts.map((label, index) => ({
        label,
        path: `/${parts.slice(0, index + 1).join('/')}`
      }))
    ];
  });

  navigate(path: string): void {
    if (path !== this.path()) {
      this.pathChange.emit(path);
    }
  }
}
