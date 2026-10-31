import { useCallback, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';

// Lists below this size render every row; windowing only pays off once several pages are loaded.
export const VIRTUALIZE_AFTER = 100;

export function useWindowRows(count) {
  const enabled = count > VIRTUALIZE_AFTER;
  const [scrollMargin, setScrollMargin] = useState(0);
  const attachBody = useCallback((node) => {
    if (node) setScrollMargin(Math.round(node.getBoundingClientRect().top + window.scrollY));
  }, []);
  const virtualizer = useWindowVirtualizer({
    count: enabled ? count : 0,
    estimateSize: () => 49,
    overscan: 10,
    scrollMargin,
  });
  if (!enabled) return { enabled: false, attachBody };
  const items = virtualizer.getVirtualItems();
  const first = items[0];
  const last = items[items.length - 1];
  return {
    enabled: true,
    attachBody,
    indexes: items.map((item) => item.index),
    measureElement: virtualizer.measureElement,
    paddingTop: first ? first.start - scrollMargin : 0,
    paddingBottom: last ? Math.max(virtualizer.getTotalSize() - (last.end - scrollMargin), 0) : 0,
  };
}
