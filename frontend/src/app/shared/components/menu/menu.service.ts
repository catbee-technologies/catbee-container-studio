import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class MenuService {
  private readonly activeMenu = signal<symbol | null>(null);

  register(menuId: symbol): void {
    this.activeMenu.set(menuId);
  }

  isActive(menuId: symbol): boolean {
    return this.activeMenu() === menuId;
  }

  close(menuId: symbol): void {
    if (this.activeMenu() === menuId) {
      this.activeMenu.set(null);
    }
  }

  closeAll(): void {
    this.activeMenu.set(null);
  }
}
