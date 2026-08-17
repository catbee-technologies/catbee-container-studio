import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class MenuService {
  private readonly activeMenu = signal<symbol | null>(null);

  isOpen(menuId: symbol): boolean {
    return this.activeMenu() === menuId;
  }

  toggle(menuId: symbol): void {
    this.activeMenu.update(current => (current === menuId ? null : menuId));
  }

  closeAll(): void {
    this.activeMenu.set(null);
  }

  close(menuId: symbol): void {
    if (this.activeMenu() === menuId) {
      this.activeMenu.set(null);
    }
  }
}
