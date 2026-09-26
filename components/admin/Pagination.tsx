import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useSettings } from '../../services/appSettings';

// Shared client-side pagination for the admin panel's long lists. Every screen loads its rows in one
// request already, so this only slices what is rendered — it keeps a 1,000-student roster or a
// 200-event audit log from painting a single unusable wall of rows.
//
// The default page size comes from the admin's own "Rows per page" preference (Settings → Interface),
// so one setting drives every table. A table's own selector overrides it until the preference changes.

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export interface PaginationState<T> {
  pageItems: T[];
  page: number; // 0-based and already clamped to the available range
  setPage: (page: number) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
  total: number;
  totalPages: number;
  from: number; // 1-based index of the first row on this page (0 when empty)
  to: number;
}

/**
 * Slice `items` into pages.
 *
 * @param resetKey Anything that changes when the underlying filter/search changes. Paging jumps back
 *   to the first page when it changes — without this, filtering a list while on page 7 leaves the
 *   admin staring at an empty table.
 * @param defaultPageSize Fixed page size for small nested tables. When given, the table opts out of
 *   the global "Rows per page" preference.
 */
export function usePagination<T>(items: T[], resetKey?: unknown, defaultPageSize?: number): PaginationState<T> {
  const { settings } = useSettings();
  const [pageSize, setPageSize] = useState(defaultPageSize ?? settings.ui.pageSize ?? 25);
  const [page, setPage] = useState(0);

  // Follow the saved preference when it changes, unless this table pinned its own size.
  useEffect(() => {
    if (defaultPageSize !== undefined) return;
    setPageSize(settings.ui.pageSize ?? 25);
    setPage(0);
  }, [settings.ui.pageSize, defaultPageSize]);

  useEffect(() => {
    setPage(0);
  }, [resetKey]);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp rather than reset: rows disappearing underneath us (a delete on the last page) should land
  // on the new last page, not silently show nothing.
  const current = Math.min(Math.max(0, page), totalPages - 1);

  const pageItems = useMemo(
    () => items.slice(current * pageSize, current * pageSize + pageSize),
    [items, current, pageSize],
  );

  return {
    pageItems,
    page: current,
    setPage,
    pageSize,
    setPageSize: (size: number) => {
      setPageSize(size);
      setPage(0);
    },
    total,
    totalPages,
    from: total === 0 ? 0 : current * pageSize + 1,
    to: Math.min(total, current * pageSize + pageSize),
  };
}

// Page numbers to render: always the first and last page, plus a window around the current one, with
// ellipses standing in for the gaps.
const buildPageList = (current: number, totalPages: number): (number | 'gap')[] => {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i);

  const pages = new Set<number>([0, totalPages - 1, current]);
  if (current - 1 > 0) pages.add(current - 1);
  if (current + 1 < totalPages - 1) pages.add(current + 1);
  // Keep the control a stable width near the ends instead of collapsing to three buttons.
  if (current <= 2) [1, 2, 3].forEach(p => p < totalPages - 1 && pages.add(p));
  if (current >= totalPages - 3) [totalPages - 4, totalPages - 3, totalPages - 2].forEach(p => p > 0 && pages.add(p));

  const sorted = Array.from(pages).sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('gap');
    out.push(p);
  });
  return out;
};

interface PaginationProps<T> {
  state: PaginationState<T>;
  /** Plural noun for the row count, e.g. "students". */
  label?: string;
  /** Hide the rows-per-page selector (small nested tables with a pinned size). */
  hidePageSize?: boolean;
  className?: string;
}

export function Pagination<T>({ state, label = 'rows', hidePageSize, className = '' }: PaginationProps<T>) {
  const { page, setPage, pageSize, setPageSize, total, totalPages, from, to } = state;

  // Nothing to page through — don't spend a row of chrome saying so.
  if (totalPages <= 1) return null;

  const pages = buildPageList(page, totalPages);
  const navBtn = 'inline-flex items-center justify-center h-8 min-w-8 px-2 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-white transition-colors';

  return (
    <div className={`flex flex-col gap-3 border-t border-slate-100 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${className}`}>
      <div className="flex items-center gap-3">
        <p className="text-xs text-slate-500">
          Showing <span className="font-semibold text-slate-700">{from}–{to}</span> of{' '}
          <span className="font-semibold text-slate-700">{total}</span> {label}
        </p>
        {!hidePageSize && (
          <label className="hidden items-center gap-1.5 text-xs text-slate-400 sm:flex">
            <span className="sr-only">Rows per page</span>
            <select
              value={pageSize}
              onChange={e => setPageSize(Number(e.target.value))}
              className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none hover:bg-slate-50"
              aria-label="Rows per page"
            >
              {PAGE_SIZE_OPTIONS.map(n => (
                <option key={n} value={n}>{n} / page</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <nav className="flex items-center gap-1" aria-label="Pagination">
        <button
          type="button"
          onClick={() => setPage(page - 1)}
          disabled={page === 0}
          className={navBtn}
          aria-label="Previous page"
        >
          <ChevronLeft size={15} />
        </button>

        {pages.map((p, i) => (p === 'gap' ? (
          <span key={`gap-${i}`} className="px-1 text-xs text-slate-300 select-none">…</span>
        ) : (
          <button
            key={p}
            type="button"
            onClick={() => setPage(p)}
            aria-current={p === page ? 'page' : undefined}
            className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-xs font-semibold transition-colors ${
              p === page
                ? 'border-[var(--lsc-primary)] bg-[var(--lsc-primary-50)] text-[var(--lsc-primary)]'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {p + 1}
          </button>
        )))}

        <button
          type="button"
          onClick={() => setPage(page + 1)}
          disabled={page >= totalPages - 1}
          className={navBtn}
          aria-label="Next page"
        >
          <ChevronRight size={15} />
        </button>
      </nav>
    </div>
  );
}
