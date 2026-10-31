import { useCallback, useLayoutEffect, useRef } from 'react';

// Returns a referentially stable function that always calls the latest `fn`,
// so memoized rows are not re-rendered just because a parent handler was recreated.
export function useStableCallback(fn) {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args) => ref.current(...args), []);
}
