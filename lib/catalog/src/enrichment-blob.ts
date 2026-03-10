// ── Enrichment Blob Parser ────────────────────────────────────────────
//
// intake-station writes a JSON blob to Odoo's x_ebay_item_specifics field.
// This module defines the blob's shape and provides a parser that
// listing-dashboard uses to safely read it.
//
// This is the ONE piece of logic in @ld/catalog — a pure function that
// validates JSON structure. No side effects, no API calls.

import type { EnrichmentCompleteness } from './product.js';

/**
 * The shape of the JSON blob stored in Odoo's x_ebay_item_specifics field.
 * Written by intake-station's enricher.ts (writeEnrichmentToOdoo).
 *
 * Example:
 * ```json
 * {
 *   "category": { "id": "177", "name": "Laptops & Netbooks", "breadcrumb": [...] },
 *   "specifics": { "Brand": "Dell", "Processor": "Intel Core i7-1165G7", ... },
 *   "requiredUnfilled": ["MPN"],
 *   "completeness": { "required": { "filled": 5, "total": 6 }, "recommended": { "filled": 8, "total": 14 } },
 *   "enrichedAt": "2026-03-10T00:00:00.000Z"
 * }
 * ```
 */
export interface EnrichmentBlob {
  category: {
    id: string;
    name: string;
    breadcrumb: string[];
  };
  specifics: Record<string, string | string[]>;
  requiredUnfilled: string[];
  completeness: EnrichmentCompleteness;
  enrichedAt: string;
}

/**
 * Parse the raw x_ebay_item_specifics string from Odoo into a typed blob.
 * Returns null if the input is missing, empty, or malformed.
 * Never throws — callers should fall back to hardcoded logic on null.
 */
export function parseEnrichmentBlob(raw: string | null | undefined | false): EnrichmentBlob | null {
  if (!raw || typeof raw !== 'string') return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Validate minimum required shape
    const category = parsed.category as Record<string, unknown> | undefined;
    if (!category || typeof category.id !== 'string' || typeof category.name !== 'string') {
      return null;
    }

    const specifics = parsed.specifics;
    if (!specifics || typeof specifics !== 'object' || Array.isArray(specifics)) {
      return null;
    }

    return {
      category: {
        id: category.id as string,
        name: category.name as string,
        breadcrumb: Array.isArray(category.breadcrumb)
          ? (category.breadcrumb as unknown[]).filter((s): s is string => typeof s === 'string')
          : [],
      },
      specifics: Object.fromEntries(
        Object.entries(specifics as Record<string, unknown>)
          .filter(([, v]) =>
            (typeof v === 'string' && v.trim() !== '') ||
            (Array.isArray(v) && v.length > 0 && v.every(item => typeof item === 'string')),
          )
          .map(([k, v]) => [k, Array.isArray(v) ? v.filter((s: string) => s.trim() !== '') : v]),
      ) as Record<string, string | string[]>,
      requiredUnfilled: Array.isArray(parsed.requiredUnfilled)
        ? (parsed.requiredUnfilled as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
      completeness: isCompleteness(parsed.completeness)
        ? parsed.completeness
        : { required: { filled: 0, total: 0 }, recommended: { filled: 0, total: 0 } },
      enrichedAt: typeof parsed.enrichedAt === 'string' ? parsed.enrichedAt : '',
    };
  } catch {
    return null;
  }
}

function isCompleteness(v: unknown): v is EnrichmentCompleteness {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return isFilledTotal(c.required) && isFilledTotal(c.recommended);
}

function isFilledTotal(v: unknown): v is { filled: number; total: number } {
  if (!v || typeof v !== 'object') return false;
  const ft = v as Record<string, unknown>;
  return typeof ft.filled === 'number' && typeof ft.total === 'number';
}
