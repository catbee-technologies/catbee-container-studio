export class PendingNavigation {
  private resolveNavigation: ((allow: boolean) => void) | null = null;

  request(): Promise<boolean> {
    this.resolve(false);
    return new Promise(resolve => {
      this.resolveNavigation = resolve;
    });
  }

  resolve(allow: boolean): void {
    const resolve = this.resolveNavigation;
    this.resolveNavigation = null;
    resolve?.(allow);
  }
}
