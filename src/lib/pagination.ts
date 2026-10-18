import { toInt } from "./validate.ts";

export interface Page {
  page: number;
  perPage: number;
  offset: number;
}

export function parsePage(url: URL, defaultPerPage = 30): Page {
  const page = toInt(url.searchParams.get("page"), 1, 1, 100_000);
  const perPage = toInt(url.searchParams.get("per_page"), defaultPerPage, 1, 100);
  return { page, perPage, offset: (page - 1) * perPage };
}

export interface Envelope<T> {
  items: T[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export function envelope<T>(items: T[], page: Page, total: number): Envelope<T> {
  return {
    items,
    page: page.page,
    per_page: page.perPage,
    total,
    total_pages: Math.max(1, Math.ceil(total / page.perPage)),
  };
}
