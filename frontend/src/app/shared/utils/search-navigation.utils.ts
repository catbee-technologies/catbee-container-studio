export type SearchNavigationDirection = -1 | 1;

export function normalizeSearchMatchIndex(index: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return ((index % total) + total) % total;
}

export function getSearchNavigationDirection(event: KeyboardEvent): SearchNavigationDirection | null {
  if (event.key !== 'Enter') {
    return null;
  }

  return event.shiftKey ? -1 : 1;
}

export function findVisibleMatchIndex<T>(
  matches: readonly T[],
  elements: NodeListOf<HTMLElement>,
  getElementIndex: (match: T) => number,
  viewport: HTMLElement,
  topInset = 0
): number {
  const viewportRect = viewport.getBoundingClientRect();
  const visibleTop = viewportRect.top + topInset;

  return matches.findIndex(match => {
    const elementRect = elements[getElementIndex(match)]?.getBoundingClientRect();
    return elementRect ? elementRect.bottom > visibleTop && elementRect.top < viewportRect.bottom : false;
  });
}

export function escapeSearchHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
