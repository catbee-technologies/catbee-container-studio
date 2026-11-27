import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class MenuService {
  private readonly activeMenus = signal<readonly symbol[]>([]);

  register(menuId: symbol, parentMenuId?: symbol): void {
    if (!parentMenuId) {
      this.activeMenus.set([menuId]);
      return;
    }
    const menus = this.activeMenus();
    const parentIndex = menus.indexOf(parentMenuId);
    if (parentIndex !== -1) {
      this.activeMenus.set([...menus.slice(0, parentIndex + 1), menuId]);
    }
  }

  isActive(menuId: symbol): boolean {
    return this.activeMenus().includes(menuId);
  }

  isTopMost(menuId: symbol): boolean {
    return this.activeMenus().at(-1) === menuId;
  }

  close(menuId: symbol): void {
    const menus = this.activeMenus();
    const index = menus.indexOf(menuId);
    if (index !== -1) {
      this.activeMenus.set(menus.slice(0, index));
    }
  }

  closeAll(): void {
    this.activeMenus.set([]);
  }
}
