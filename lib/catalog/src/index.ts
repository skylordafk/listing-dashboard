export {
  type EnrichedProduct,
  type ItemSpecific,
  type SpecificSource,
  type EnrichmentCompleteness,
  type EbayConditionId,
  EBAY_CONDITIONS,
  CONDITION_LABEL_TO_ID,
} from './product.js';

export {
  type CategorySuggestion,
  type TaxonomyAspect,
} from './taxonomy.js';

export {
  type EnrichmentBlob,
  parseEnrichmentBlob,
} from './enrichment-blob.js';

export {
  ODOO_ENRICHMENT_FIELDS,
  type OdooEnrichmentField,
  ODOO_LISTING_FIELDS,
  type OdooListingField,
  ODOO_ALL_FIELDS,
} from './odoo-fields.js';
