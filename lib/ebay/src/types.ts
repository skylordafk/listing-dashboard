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
  item_specifics?: ItemSpecific[];
  // Inline policy fields (fallback when no business policies)
  returns_accepted?: boolean;
  return_days?: number;
  shipping_cost?: number;
}

export interface ItemSpecific {
  Name: string;
  Value: string;
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

// ── Image ────────────────────────────────────────────────────────────

export interface OdooImage {
  datas: string; // base64-encoded
  name?: string;
}

// ── eBay Performance / My eBay Selling Types ─────────────────────────

export interface EbaySellingStatus {
  currentPrice: number;
  currentPriceCurrency: string;
  convertedCurrentPrice?: number;
  quantitySold: number;
  listingStatus: string;
  promotedListingFee?: number;
}

export interface EbayListingDetails {
  startTime: string;    // ISO date
  endTime?: string;     // ISO date
  viewItemURL: string;
}

export interface EbayTransaction {
  transactionId: string;
  transactionPrice: number;
  transactionPriceCurrency: string;
  createdDate: string;  // ISO date
  buyerUserId?: string;
  quantityPurchased: number;
}

export interface EbayActiveItem {
  itemId: string;
  title: string;
  sku: string | null;
  watchCount: number;
  quantitySold: number;
  sellingStatus: EbaySellingStatus;
  listingDetails: EbayListingDetails;
}

export interface EbaySoldItem {
  itemId: string;
  title: string;
  sku: string | null;
  quantitySold: number;
  sellingStatus: EbaySellingStatus;
  listingDetails: EbayListingDetails;
  transactions: EbayTransaction[];
}

export interface EbayUnsoldItem {
  itemId: string;
  title: string;
  sku: string | null;
  sellingStatus: EbaySellingStatus;
  listingDetails: EbayListingDetails;
}

export interface MyeBaySellingResult {
  activeItems: EbayActiveItem[];
  soldItems: EbaySoldItem[];
  unsoldItems: EbayUnsoldItem[];
}

export interface EbayItemDetail {
  itemId: string;
  title: string;
  sku: string | null;
  description: string;
  currentPrice: number;
  currentPriceCurrency: string;
  conditionId: string;
  conditionDisplayName: string;
  watchCount: number;
  hitCount: number;
  quantitySold: number;
  quantityAvailable: number;
  listingDetails: EbayListingDetails;
  sellingStatus: EbaySellingStatus;
  itemSpecifics: ItemSpecific[];
  pictureURLs: string[];
}
