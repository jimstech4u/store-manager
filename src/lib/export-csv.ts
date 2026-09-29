'use client';

/**
 * EXPORTING A LIST — every row that matches, as a CSV.
 *
 * "export filtered list from stock, account, money." A list on screen holds the pages that have been
 * scrolled to; an export of that would be a spreadsheet that quietly stops at thirty rows. So the
 * export walks the SAME server query, with the same filter, page by page to the end.
 */

/** Every row a paged query has, from the first page to the last. Capped so a runaway stops. */
export async function fetchAllPages<T>(
  fetchPage: (cursor: unknown | null, limit: number) => Promise<{ rows: T[]; cursor: unknown | null }>,
  { pageSize = 100, max = 20000 }: { pageSize?: number; max?: number } = {},
): Promise<T[]> {
  const out: T[] = [];
  let cursor: unknown | null = null;
  for (;;) {
    const { rows, cursor: next } = await fetchPage(cursor, pageSize);
    out.push(...rows);
    if (rows.length < pageSize || !next || out.length >= max) break;
    cursor = next;
  }
  return out;
}

/** One column: its heading, and how to read it off a row. */
export interface CsvColumn<T> {
  head: string;
  value: (row: T) => string | number | null | undefined;
}

/** RFC 4180: a field with a comma, quote or newline is quoted, and its quotes doubled. */
function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => cell(c.head)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(c.value(r))).join(','));
  // A byte-order mark, so Excel reads ₦ and names with accents as the shop typed them.
  return '﻿' + lines.join('\r\n');
}

/**
 * Hand the file over: the phone's share sheet where it can take a file (WhatsApp, email, Drive),
 * a download everywhere else. Says which happened.
 */
export async function shareCsv(filename: string, csv: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const file = new File([blob], filename, { type: 'text/csv' });
  const nav = navigator as Navigator & { canShare?: (d: { files?: File[] }) => boolean };
  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return 'downloaded';
}

/** "stock-running-low-2026-09-29.csv" */
export function csvName(what: string, filter: string | null): string {
  const day = new Date().toISOString().slice(0, 10);
  return `${what}${filter && filter !== 'all' ? `-${filter.replace(/_/g, '-')}` : ''}-${day}.csv`;
}
