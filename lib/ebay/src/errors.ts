/** General eBay API error. */
export class EbayApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EbayApiError';
  }
}

/** eBay authentication/token error (expired or invalid OAuth token). */
export class EbayAuthError extends EbayApiError {
  constructor(message: string) {
    super(message);
    this.name = 'EbayAuthError';
  }
}
