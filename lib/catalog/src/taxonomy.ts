// ── eBay Taxonomy API Types ───────────────────────────────────────────
//
// Shared type definitions for eBay's Taxonomy REST API responses.
// Both intake-station and listing-dashboard query the same API and
// previously defined identical types independently.
//
// These types describe eBay's vocabulary — category suggestions and
// item aspects (what eBay calls the valid specifics for a given category).

/**
 * A suggested eBay category returned by the Taxonomy API's
 * get_category_suggestions endpoint.
 */
export interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  breadcrumb: string[];  // root → leaf
  level: number;
}

/**
 * An item aspect (item specific) for a given eBay category, returned by
 * the Taxonomy API's get_item_aspects_for_category endpoint.
 *
 * This describes what eBay WANTS for a category — the aspect name, whether
 * it's required, whether values must come from a fixed list (SELECTION_ONLY)
 * or can be free text, and the allowed values if applicable.
 *
 * intake-station uses these to build AI fill prompts.
 * listing-dashboard uses these for value normalization and validation.
 */
export interface TaxonomyAspect {
  name: string;
  required: boolean;
  usage: string;        // 'RECOMMENDED' | 'OPTIONAL'
  dataType: string;     // 'STRING' | 'NUMBER' | 'DATE'
  mode: string;         // 'FREE_TEXT' | 'SELECTION_ONLY'
  multiValue: boolean;
  values: string[];     // allowed values (populated for SELECTION_ONLY)
}
