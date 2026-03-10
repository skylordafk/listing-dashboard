// ── Enriched Product ─────────────────────────────────────────────────
//
// The shared contract between intake-station (producer) and
// listing-dashboard (consumer). Defines what a fully-enriched product
// looks like after intake processing.
//
// Two layers:
//   1. Universal fields — same for every item, every category
//   2. Dynamic item_specifics — determined by eBay category at runtime

/**
 * A product that has been identified, categorized, and enriched with
 * eBay-ready data. This is the handoff format between intake-station
 * (which produces it) and listing-dashboard (which reviews and uploads it).
 */
export interface EnrichedProduct {
  // ── Identity ────────────────────────────────────────────────────
  sku: string;
  brand: string;
  model?: string;
  series?: string;
  suggested_name: string;

  // ── Listing content ─────────────────────────────────────────────
  title: string;
  description_html: string;

  // ── eBay category (dynamically resolved) ────────────────────────
  ebay_category_id: string;
  ebay_category_name: string;
  ebay_category_breadcrumb: string[];

  // ── Condition ───────────────────────────────────────────────────
  condition_id: EbayConditionId;
  condition_description?: string;

  // ── Pricing ─────────────────────────────────────────────────────
  price: number;
  cost?: number;
  currency: string;

  // ── Dynamic item specifics ──────────────────────────────────────
  item_specifics: ItemSpecific[];

  // ── Enrichment metadata ─────────────────────────────────────────
  enrichment_completeness?: EnrichmentCompleteness;
  enriched_at?: string;
}

/**
 * A single eBay item specific (aspect). The valid names and allowed values
 * for each are determined at runtime by querying eBay's Taxonomy API for
 * the resolved category — they are NOT hardcoded per product type.
 */
export interface ItemSpecific {
  name: string;
  value: string | string[];
  source?: SpecificSource;
}

/**
 * How a specific's value was determined. Ordered roughly by confidence:
 * system_script > ai_vision > ai_research > odoo_field > manual
 */
export type SpecificSource =
  | 'system_script'
  | 'ai_vision'
  | 'ai_research'
  | 'manual'
  | 'odoo_field';

export interface EnrichmentCompleteness {
  required: { filled: number; total: number };
  recommended: { filled: number; total: number };
}

// ── eBay Condition IDs ───────────────────────────────────────────────

export const EBAY_CONDITIONS = {
  new:                   1000,
  certified_refurbished: 2000,
  seller_refurbished:    2500,
  used:                  3000,
  for_parts:             7000,
} as const;

export type EbayConditionId = typeof EBAY_CONDITIONS[keyof typeof EBAY_CONDITIONS];

/**
 * Maps intake-station's human-readable condition labels to eBay condition IDs.
 * intake-station writes x_condition as one of these string values;
 * listing-dashboard needs the numeric eBay condition ID.
 */
export const CONDITION_LABEL_TO_ID: Record<string, EbayConditionId> = {
  'new':       1000,
  'like_new':  2500,
  'good':      3000,
  'fair':      3000,
  'parts':     7000,
};
