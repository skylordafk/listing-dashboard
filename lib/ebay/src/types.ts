// Re-export the catalog's canonical ItemSpecific type alongside the legacy shape
export type { ItemSpecific } from '@ld/catalog';

/**
 * Legacy item-specific shape used throughout listing-dashboard.
 * Capital-letter keys (Name/Value) match the eBay Trading API XML format.
 * Phase 2 will migrate consumers to the catalog's lowercase shape.
 */
export interface LegacyItemSpecific {
  Name: string;
  Value: string;
}

// ── eBay Config ──────────────────────────────────────────────────────

export interface EbayConfig {
  appId: string;
  devId: string;
  certId: string;
  oauthToken: string;
  refreshToken?: string;
  redirectUri?: string;
  apiUrl: string;
  apiVersion: string;
  siteId: string;
  postalCode: string;
  location: string;
  businessPolicies: BusinessPolicies;
  defaultConditionDescription: string;
}

export interface BusinessPolicies {
  paymentPolicyId: string;
  returnPolicyId: string;
  shippingPolicyId: string;
}

// ── Listing Data ─────────────────────────────────────────────────────

export interface ListingData {
  title: string;
  sku?: string;
  description_html: string;
  price: number;
  category_id?: string;
  condition_id?: string;
  condition_description?: string;
  listing_duration?: string;
  country?: string;
  currency?: string;
  location?: string;
  postal_code?: string;
  dispatch_days?: number;
  item_specifics?: LegacyItemSpecific[];
  // Inline policy fields (fallback when no business policies)
  returns_accepted?: boolean;
  return_days?: number;
  shipping_cost?: number;
}

// ── API Responses ────────────────────────────────────────────────────

export interface AddItemResult {
  itemId: string;
  fees: Fee[];
}

export interface VerifyAddItemResult {
  fees: Fee[];
  warnings: ApiWarning[];
}

export interface ReviseItemResult {
  status: string;
  itemId: string;
}

export interface Fee {
  name: string;
  amount: string;
}

export interface ApiWarning {
  code: string;
  message: string;
}

export interface TestConnectionResult {
  status: string;
  ebayUser: string;
}

// ── Category Specifics ───────────────────────────────────────────────

export interface CategoryAspect {
  name: string;
  values: string[];
  selectionMode: string;
  usage: string;
  required: boolean;
}

export interface CategorySpecificsResult {
  categoryId: string;
  categorySiteId: string;
  aspects: CategoryAspect[];
}

