export { EbayClient } from './client.js';
export { EbayTaxonomyClient } from './taxonomy.js';
export { loadEbayConfig } from './config.js';
export { EbayApiError, EbayAuthError } from './errors.js';
export { xmlEscape } from './xml.js';
export type {
  EbayConfig, ListingData, ItemSpecific, LegacyItemSpecific,
  AddItemResult, VerifyAddItemResult, ReviseItemResult,
  TestConnectionResult, Fee, ApiWarning,
  CategorySpecificsResult, CategoryAspect,
} from './types.js';
export type {
  CategorySuggestion, CategorySuggestionsResult,
  TaxonomyAspect, ItemAspectsResult,
} from './taxonomy.js';
