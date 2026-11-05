import { useEffect, useRef, useState } from 'react';
import api from '../lib/api.js';
import { beginRequest, isCanceled } from '../lib/requestControl.js';

const PICKER_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

// Server-side searchable customer options for selection controls. Loads only while `enabled`,
// debounces typing, and aborts superseded requests. The selected customer stays listed even when
// a later search no longer returns it.
// `isSelected(row)` identifies the currently chosen option (or is null) so it stays listed after later searches.
export default function usePickerCustomers(enabled, isSelected = null) {
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState([]);
  const [state, setState] = useState({ loading: false, error: '', total: 0, hasMore: false });
  const registry = useRef({});
  const selectedRef = useRef(null);

  async function fetchPage(offset, append) {
    const controller = beginRequest(registry.current, 'picker');
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const params = new URLSearchParams({ limit: String(PICKER_PAGE_SIZE), offset: String(offset), fields: 'picker' });
      if (search.trim()) params.set('search', search.trim());
      const response = await api.get(`/customers?${params}`, { signal: controller.signal });
      const page = response.data.customers || [];
      setOptions((current) => (append ? [...current, ...page.filter((row) => !current.some((existing) => existing.id === row.id))] : page));
      setState({ loading: false, error: '', total: response.data.total || 0, hasMore: response.data.hasMore === true });
    } catch (error) {
      if (isCanceled(error)) return;
      setState((current) => ({ ...current, loading: false, error: error.response?.data?.message || 'Could not load customers.' }));
    }
  }

  const latest = useRef(fetchPage);
  latest.current = fetchPage;

  useEffect(() => {
    const registryRef = registry.current;
    if (!enabled) {
      registryRef.picker?.abort();
      return undefined;
    }
    const timer = setTimeout(() => latest.current(0, false), search ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      clearTimeout(timer);
      registryRef.picker?.abort();
    };
  }, [enabled, search]);

  useEffect(() => {
    if (!enabled) {
      setSearch('');
      setOptions([]);
      selectedRef.current = null;
    }
  }, [enabled]);

  const match = isSelected ? options.find(isSelected) : null;
  if (match) selectedRef.current = match;
  if (!isSelected) selectedRef.current = null;
  const selected = selectedRef.current && isSelected?.(selectedRef.current) ? selectedRef.current : null;
  const visible = selected && !match ? [selected, ...options] : options;

  return {
    customers: visible,
    search,
    setSearch,
    loading: state.loading,
    error: state.error,
    total: state.total,
    hasMore: state.hasMore,
    loadMore: () => { if (!state.loading && state.hasMore) fetchPage(options.length, true); },
  };
}
