import { loadEbayConfig } from './config.js';
import { EbayApiError, EbayAuthError } from './errors.js';
import { parseXml, xmlEscape, xmlGet, xmlFindAll, safeCdata } from './xml.js';
import type {
  EbayConfig, ListingData, AddItemResult, VerifyAddItemResult,
  ReviseItemResult, TestConnectionResult, CategorySpecificsResult,
  CategoryAspect, Fee, ApiWarning, OdooImage,
  MyeBaySellingResult, EbayActiveItem, EbaySoldItem, EbayUnsoldItem,
  EbayItemDetail, EbaySellingStatus, EbayListingDetails, EbayTransaction,
} from './types.js';

const EBAY_NS = 'urn:ebay:apis:eBLBaseComponents';
const AUTH_ERROR_CODES = new Set(['931', '930', '17', '215']);

export class EbayClient {
  private config: EbayConfig;

  constructor(config?: EbayConfig | { configPath?: string }) {
    if (config && 'appId' in config) {
      this.config = config;
    } else {
      this.config = loadEbayConfig((config as { configPath?: string })?.configPath);
    }
  }

  // ── Headers ────────────────────────────────────────────────────────

  private buildHeaders(callName: string): Record<string, string> {
    return {
      'X-EBAY-API-COMPATIBILITY-LEVEL': this.config.apiVersion,
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': this.config.siteId,
      'X-EBAY-API-APP-NAME': this.config.appId,
      'X-EBAY-API-DEV-NAME': this.config.devId,
      'X-EBAY-API-CERT-NAME': this.config.certId,
      'Content-Type': 'text/xml; charset=utf-8',
    };
  }

  // ── Core request ────────────────────────────────────────────────────

  private async makeRequest(callName: string, requestXml: string): Promise<Record<string, unknown>> {
    const headers = this.buildHeaders(callName);
    const response = await fetch(this.config.apiUrl, {
      method: 'POST',
      headers,
      body: requestXml,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new EbayApiError(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const xml = await response.text();
    const root = parseXml(xml);

    // Find the response envelope (e.g., AddItemResponse, GetUserResponse)
    const responseKey = Object.keys(root).find(k => k.endsWith('Response'));
    const envelope = (responseKey ? root[responseKey] : root) as Record<string, unknown>;

    const ack = String(xmlGet(envelope, 'Ack') ?? '');

    if (ack === 'Failure' || ack === 'PartialFailure') {
      const errors = xmlFindAll(envelope, 'Errors') as Record<string, unknown>[];
      const errorMessages: string[] = [];

      for (const error of errors) {
        const code = String(error.ErrorCode ?? 'unknown');
        const msg = String(error.LongMessage ?? error.ShortMessage ?? 'Unknown error');

        if (AUTH_ERROR_CODES.has(code)) {
          throw new EbayAuthError(`OAuth token invalid/expired (code ${code}): ${msg}`);
        }
        errorMessages.push(`[${code}] ${msg}`);
      }

      if (ack === 'Failure') {
        throw new EbayApiError(errorMessages.join('; '));
      }
      // PartialFailure: log but continue
      console.warn('eBay PartialFailure:', errorMessages.join('; '));
    }

    return envelope;
  }

  // ── Test connection ─────────────────────────────────────────────────

  async testConnection(): Promise<TestConnectionResult> {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetUserRequest xmlns="${EBAY_NS}">
    <RequesterCredentials>
        <eBayAuthToken>${this.config.oauthToken}</eBayAuthToken>
    </RequesterCredentials>
</GetUserRequest>`;

    const envelope = await this.makeRequest('GetUser', xml);
    const userId = String(xmlGet(envelope, 'User.UserID') ?? 'Unknown');

    return { status: 'ok', ebayUser: userId };
  }

  // ── Picture upload ──────────────────────────────────────────────────

  async uploadPicture(imageDataB64: string, imageName = 'photo.jpg'): Promise<string> {
    const requestXml = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="${EBAY_NS}">
    <RequesterCredentials>
        <eBayAuthToken>${this.config.oauthToken}</eBayAuthToken>
    </RequesterCredentials>
    <PictureName>${xmlEscape(imageName)}</PictureName>
    <PictureSet>Supersize</PictureSet>
</UploadSiteHostedPicturesRequest>`;

    const headers = this.buildHeaders('UploadSiteHostedPictures');
    delete (headers as Record<string, string>)['Content-Type']; // FormData sets its own

    const imageBytes = Buffer.from(imageDataB64, 'base64');
    const form = new FormData();
    form.append('XML Payload', new Blob([requestXml], { type: 'text/xml' }), 'payload.xml');
    form.append('image', new Blob([imageBytes], { type: 'image/jpeg' }), imageName);

    const response = await fetch(this.config.apiUrl, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new EbayApiError(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const xml = await response.text();
    const root = parseXml(xml);
    const responseKey = Object.keys(root).find(k => k.endsWith('Response'));
    const envelope = (responseKey ? root[responseKey] : root) as Record<string, unknown>;

    const ack = String(xmlGet(envelope, 'Ack') ?? '');
    if (ack === 'Failure' || ack === 'PartialFailure') {
      const errors = xmlFindAll(envelope, 'Errors') as Record<string, unknown>[];
      const msgs: string[] = [];
      for (const error of errors) {
        const code = String(error.ErrorCode ?? 'unknown');
        const msg = String(error.LongMessage ?? 'Unknown error');
        if (AUTH_ERROR_CODES.has(code)) {
          throw new EbayAuthError(`OAuth token invalid/expired (code ${code}): ${msg}`);
        }
        msgs.push(`[${code}] ${msg}`);
      }
      throw new EbayApiError(msgs.join('; '));
    }

    const url = xmlGet(envelope, 'SiteHostedPictureDetails.FullURL');
    if (!url) throw new EbayApiError('No picture URL in UploadSiteHostedPictures response');

    return String(url);
  }

  async uploadPictures(images: OdooImage[]): Promise<string[]> {
    const results = await Promise.allSettled(
      images.map(img => this.uploadPicture(img.datas, img.name ?? 'photo.jpg'))
    );
    const urls: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        urls.push(result.value);
      } else {
        console.warn('Image upload failed:', result.reason);
      }
    }
    return urls;
  }

  // ── Listing XML builder ──────────────────────────────────────────────

  private buildItemXml(data: ListingData, imageUrls: string[], callName: string): string {
    const specificsXml = (data.item_specifics ?? []).map(s =>
      `\n            <NameValueList>\n                <Name>${xmlEscape(s.Name)}</Name>\n                <Value>${xmlEscape(s.Value)}</Value>\n            </NameValueList>`
    ).join('');

    const picturesXml = imageUrls.map(url =>
      `\n            <PictureURL>${xmlEscape(url)}</PictureURL>`
    ).join('');

    const currency = data.currency ?? 'USD';
    const sku = xmlEscape(data.sku ?? '').slice(0, 50);
    const location = xmlEscape(data.location ?? this.config.location);
    const postalCode = xmlEscape(data.postal_code ?? this.config.postalCode);

    return `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="${EBAY_NS}">
    <RequesterCredentials>
        <eBayAuthToken>${this.config.oauthToken}</eBayAuthToken>
    </RequesterCredentials>
    <Item>
        <Title>${xmlEscape(data.title)}</Title>
        <SKU>${sku}</SKU>
        <PrimaryCategory>
            <CategoryID>${data.category_id ?? '177'}</CategoryID>
        </PrimaryCategory>
        <ConditionID>${data.condition_id ?? '3000'}</ConditionID>
        <ConditionDescription>${xmlEscape(data.condition_description ?? '')}</ConditionDescription>
        <StartPrice currencyID="${currency}">${data.price.toFixed(2)}</StartPrice>
        <Quantity>1</Quantity>
        <ListingDuration>${data.listing_duration ?? 'GTC'}</ListingDuration>
        <ListingType>FixedPriceItem</ListingType>
        <Country>${data.country ?? 'US'}</Country>
        <Currency>${currency}</Currency>
        <Location>${location}</Location>
        <PostalCode>${postalCode}</PostalCode>
        <Description><![CDATA[${safeCdata(data.description_html)}]]></Description>
        <DispatchTimeMax>${data.dispatch_days ?? 3}</DispatchTimeMax>
        <PictureDetails>${picturesXml}
        </PictureDetails>
        <ItemSpecifics>${specificsXml}
        </ItemSpecifics>
${this.buildPolicyXml(data, currency)}
    </Item>
</${callName}Request>`;
  }

  private buildPolicyXml(data: ListingData, currency: string): string {
    const bp = this.config.businessPolicies;
    if (bp.paymentPolicyId && bp.returnPolicyId && bp.shippingPolicyId) {
      return `        <SellerProfiles>
            <SellerPaymentProfile>
                <PaymentProfileID>${bp.paymentPolicyId}</PaymentProfileID>
            </SellerPaymentProfile>
            <SellerReturnProfile>
                <ReturnProfileID>${bp.returnPolicyId}</ReturnProfileID>
            </SellerReturnProfile>
            <SellerShippingProfile>
                <ShippingProfileID>${bp.shippingPolicyId}</ShippingProfileID>
            </SellerShippingProfile>
        </SellerProfiles>`;
    }

    const dispatchDays = data.dispatch_days ?? 3;
    const returnDays = data.return_days ?? 30;
    const returnsAccepted = data.returns_accepted !== false ? 'ReturnsAccepted' : 'ReturnsNotAccepted';
    const shippingCost = data.shipping_cost ?? 0;
    const freeShipping = shippingCost === 0 ? 'true' : 'false';

    return `        <ReturnPolicy>
            <ReturnsAcceptedOption>${returnsAccepted}</ReturnsAcceptedOption>
            <ReturnsWithinOption>Days_${returnDays}</ReturnsWithinOption>
            <RefundOption>MoneyBack</RefundOption>
            <ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption>
        </ReturnPolicy>
        <ShippingDetails>
            <ShippingType>Flat</ShippingType>
            <ShippingServiceOptions>
                <ShippingServicePriority>1</ShippingServicePriority>
                <ShippingService>USPSPriority</ShippingService>
                <ShippingServiceCost currencyID="${currency}">${shippingCost.toFixed(2)}</ShippingServiceCost>
                <FreeShipping>${freeShipping}</FreeShipping>
            </ShippingServiceOptions>
        </ShippingDetails>`;
  }

  // ── Fees parser ─────────────────────────────────────────────────────

  private parseFees(envelope: Record<string, unknown>): Fee[] {
    const feeNodes = xmlFindAll(envelope, 'Fee') as Record<string, unknown>[];
    const fees: Fee[] = [];
    for (const node of feeNodes) {
      // Fee nodes have Name and Fee (amount) children
      // But since we findAll 'Fee', some matches are the Fee *amount* inside the Fee *container*
      if (node.Name != null) {
        fees.push({
          name: String(node.Name),
          amount: String(xmlGet(node, 'Fee') ?? xmlGet(node, 'Fee.#text') ?? '0'),
        });
      }
    }
    return fees;
  }

  // ── AddItem ─────────────────────────────────────────────────────────

  async addItem(listingData: ListingData, imageUrls: string[] = []): Promise<AddItemResult> {
    const xml = this.buildItemXml(listingData, imageUrls, 'AddItem');
    const envelope = await this.makeRequest('AddItem', xml);

    const itemId = xmlGet(envelope, 'ItemID');
    if (!itemId) throw new EbayApiError('No ItemID in AddItem response');

    return {
      itemId: String(itemId),
      fees: this.parseFees(envelope),
    };
  }

  // ── VerifyAddItem ───────────────────────────────────────────────────

  async verifyAddItem(listingData: ListingData, imageUrls: string[] = []): Promise<VerifyAddItemResult> {
    const xml = this.buildItemXml(listingData, imageUrls, 'VerifyAddItem');
    const envelope = await this.makeRequest('VerifyAddItem', xml);

    const warnings: ApiWarning[] = [];
    const errorNodes = xmlFindAll(envelope, 'Errors') as Record<string, unknown>[];
    for (const err of errorNodes) {
      if (String(err.SeverityCode ?? '') === 'Warning') {
        warnings.push({
          code: String(err.ErrorCode ?? 'unknown'),
          message: String(err.LongMessage ?? 'Unknown warning'),
        });
      }
    }

    return {
      fees: this.parseFees(envelope),
      warnings,
    };
  }

  // ── ReviseItem ──────────────────────────────────────────────────────

  async reviseItem(
    ebayItemId: string,
    updates: { title?: string; price?: number; description_html?: string },
  ): Promise<ReviseItemResult> {
    let updateFields = '';
    if (updates.title) updateFields += `\n        <Title>${xmlEscape(updates.title)}</Title>`;
    if (updates.price != null) updateFields += `\n        <StartPrice currencyID="USD">${updates.price.toFixed(2)}</StartPrice>`;
    if (updates.description_html) updateFields += `\n        <Description><![CDATA[${safeCdata(updates.description_html)}]]></Description>`;

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="${EBAY_NS}">
    <RequesterCredentials>
        <eBayAuthToken>${this.config.oauthToken}</eBayAuthToken>
    </RequesterCredentials>
    <Item>
        <ItemID>${ebayItemId}</ItemID>${updateFields}
    </Item>
</ReviseItemRequest>`;

    await this.makeRequest('ReviseItem', xml);
    return { status: 'ok', itemId: ebayItemId };
  }

  // ── GetCategorySpecifics ─────────────────────────────────────────────

  async getCategorySpecifics(categoryId: string, categorySiteId = '0'): Promise<CategorySpecificsResult> {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetCategorySpecificsRequest xmlns="${EBAY_NS}">
    <RequesterCredentials>
        <eBayAuthToken>${this.config.oauthToken}</eBayAuthToken>
    </RequesterCredentials>
    <CategorySpecific>
        <CategoryID>${xmlEscape(categoryId)}</CategoryID>
    </CategorySpecific>
    <CategorySiteID>${xmlEscape(categorySiteId)}</CategorySiteID>
    <DetailLevel>ReturnAll</DetailLevel>
</GetCategorySpecificsRequest>`;

    const envelope = await this.makeRequest('GetCategorySpecifics', xml);

    const aspects: CategoryAspect[] = [];
    const nameNodes = xmlFindAll(envelope, 'NameRecommendation') as Record<string, unknown>[];

    for (const node of nameNodes) {
      const name = String(node.Name ?? '').trim();
      if (!name) continue;

      const values: string[] = [];
      const valueRecs = xmlFindAll(node, 'ValueRecommendation') as Record<string, unknown>[];
      for (const vr of valueRecs) {
        const v = String(vr.Value ?? '').trim();
        if (v) values.push(v);
      }

      const validation = (node.ValidationRules ?? {}) as Record<string, unknown>;
      const selectionMode = String(validation.SelectionMode ?? '');
      const usage = String(validation.UsageConstraint ?? '');

      aspects.push({
        name,
        values,
        selectionMode,
        usage,
        required: usage.toLowerCase() === 'required',
      });
    }

    aspects.sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    return { categoryId: String(categoryId), categorySiteId: String(categorySiteId), aspects };
  }
  // ── GetMyeBaySelling ────────────────────────────────────────────────

  async getMyeBaySelling(options?: {
    activeList?: boolean;
    soldList?: boolean;
    unsoldList?: boolean;
    daysBack?: number;
  }): Promise<MyeBaySellingResult> {
    const opts = { activeList: false, soldList: false, unsoldList: false, daysBack: 30, ...options };

    let sections = '';
    if (opts.activeList) {
      sections += `
    <ActiveList>
        <Include>true</Include>
        <IncludeWatchCount>true</IncludeWatchCount>
        <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>1</PageNumber></Pagination>
    </ActiveList>`;
    }
    if (opts.soldList) {
      sections += `
    <SoldList>
        <Include>true</Include>
        <DurationInDays>${opts.daysBack}</DurationInDays>
        <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>1</PageNumber></Pagination>
    </SoldList>`;
    }
    if (opts.unsoldList) {
      sections += `
    <UnsoldList>
        <Include>true</Include>
        <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>1</PageNumber></Pagination>
    </UnsoldList>`;
    }

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="${EBAY_NS}">
    <RequesterCredentials>
        <eBayAuthToken>${this.config.oauthToken}</eBayAuthToken>
    </RequesterCredentials>${sections}
</GetMyeBaySellingRequest>`;

    const envelope = await this.makeRequest('GetMyeBaySelling', xml);

    const result: MyeBaySellingResult = {
      activeItems: [],
      soldItems: [],
      unsoldItems: [],
    };

    // Parse active items
    if (opts.activeList) {
      const activeList = xmlGet(envelope, 'ActiveList') as Record<string, unknown> | undefined;
      if (activeList) {
        const itemArray = xmlGet(activeList, 'ItemArray') as Record<string, unknown> | undefined;
        const items = this.ensureArray(itemArray?.Item);
        for (const item of items) {
          result.activeItems.push(this.parseActiveItem(item as Record<string, unknown>));
        }
      }
    }

    // Parse sold items
    if (opts.soldList) {
      const soldList = xmlGet(envelope, 'SoldList') as Record<string, unknown> | undefined;
      if (soldList) {
        const orderTxArray = xmlGet(soldList, 'OrderTransactionArray') as Record<string, unknown> | undefined;
        if (orderTxArray) {
          const orderTxs = this.ensureArray((orderTxArray as Record<string, unknown>).OrderTransaction);
          for (const orderTx of orderTxs) {
            const otx = orderTx as Record<string, unknown>;
            // Transaction is always an array (xml.ts isArray), take first element
            const txArr = this.ensureArray(otx.Transaction);
            const txNode = txArr[0] as Record<string, unknown> | undefined;
            if (txNode) {
              const soldItem = this.parseSoldItemFromTransaction(txNode);
              if (soldItem) result.soldItems.push(soldItem);
            }
          }
        }
      }
    }

    // Parse unsold items
    if (opts.unsoldList) {
      const unsoldList = xmlGet(envelope, 'UnsoldList') as Record<string, unknown> | undefined;
      if (unsoldList) {
        const itemArray = xmlGet(unsoldList, 'ItemArray') as Record<string, unknown> | undefined;
        const items = this.ensureArray(itemArray?.Item);
        for (const item of items) {
          result.unsoldItems.push(this.parseUnsoldItem(item as Record<string, unknown>));
        }
      }
    }

    return result;
  }

  // ── GetItem ─────────────────────────────────────────────────────────

  async getItem(itemId: string, options?: {
    includeWatchCount?: boolean;
  }): Promise<EbayItemDetail> {
    const includeWatch = options?.includeWatchCount !== false;
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="${EBAY_NS}">
    <RequesterCredentials>
        <eBayAuthToken>${this.config.oauthToken}</eBayAuthToken>
    </RequesterCredentials>
    <ItemID>${xmlEscape(itemId)}</ItemID>
    <DetailLevel>ReturnAll</DetailLevel>${includeWatch ? '\n    <IncludeWatchCount>true</IncludeWatchCount>' : ''}
</GetItemRequest>`;

    const envelope = await this.makeRequest('GetItem', xml);
    const item = (xmlGet(envelope, 'Item') ?? envelope) as Record<string, unknown>;

    const sellingStatus = this.parseSellingStatus(item.SellingStatus as Record<string, unknown> | undefined);
    const listingDetails = this.parseListingDetails(item.ListingDetails as Record<string, unknown> | undefined);

    // Parse item specifics
    const specifics: { Name: string; Value: string }[] = [];
    const nvLists = xmlFindAll(item, 'NameValueList') as Record<string, unknown>[];
    for (const nv of nvLists) {
      const name = String(nv.Name ?? '');
      const value = String(nv.Value ?? '');
      if (name) specifics.push({ Name: name, Value: value });
    }

    // Parse picture URLs
    const picDetails = item.PictureDetails as Record<string, unknown> | undefined;
    const picUrls = this.ensureArray(picDetails?.PictureURL).map(u => String(u));

    return {
      itemId: String(item.ItemID ?? itemId),
      title: String(item.Title ?? ''),
      sku: item.SKU ? String(item.SKU) : null,
      description: String(item.Description ?? ''),
      currentPrice: sellingStatus.currentPrice,
      currentPriceCurrency: sellingStatus.currentPriceCurrency,
      conditionId: String(item.ConditionID ?? ''),
      conditionDisplayName: String(item.ConditionDisplayName ?? ''),
      watchCount: Number(item.WatchCount ?? 0),
      hitCount: Number(item.HitCount ?? 0),
      quantitySold: sellingStatus.quantitySold,
      quantityAvailable: Number(item.Quantity ?? 0) - sellingStatus.quantitySold,
      listingDetails,
      sellingStatus,
      itemSpecifics: specifics,
      pictureURLs: picUrls,
    };
  }

  // ── Helper: ensure value is array ──────────────────────────────────

  private ensureArray(val: unknown): unknown[] {
    if (val == null) return [];
    return Array.isArray(val) ? val : [val];
  }

  // ── Helper parsers ─────────────────────────────────────────────────

  private parseSellingStatus(ss: Record<string, unknown> | undefined): EbaySellingStatus {
    if (!ss) return { currentPrice: 0, currentPriceCurrency: 'USD', quantitySold: 0, listingStatus: '' };

    const currentPrice = ss.CurrentPrice;
    let priceVal = 0;
    let currency = 'USD';
    if (typeof currentPrice === 'object' && currentPrice != null) {
      const priceObj = currentPrice as Record<string, unknown>;
      priceVal = Number(priceObj['#text'] ?? priceObj['__text'] ?? 0);
      currency = String(priceObj['@_currencyID'] ?? 'USD');
    } else {
      priceVal = Number(currentPrice ?? 0);
    }

    let promotedFee: number | undefined;
    if (ss.PromotionalSaleDetails || ss.PromotedListingFee) {
      promotedFee = Number(ss.PromotedListingFee ?? 0);
    }

    return {
      currentPrice: priceVal,
      currentPriceCurrency: currency,
      convertedCurrentPrice: ss.ConvertedCurrentPrice ? Number(
        typeof ss.ConvertedCurrentPrice === 'object'
          ? (ss.ConvertedCurrentPrice as Record<string, unknown>)['#text']
          : ss.ConvertedCurrentPrice
      ) : undefined,
      quantitySold: Number(ss.QuantitySold ?? 0),
      listingStatus: String(ss.ListingStatus ?? ''),
      promotedListingFee: promotedFee,
    };
  }

  private parseListingDetails(ld: Record<string, unknown> | undefined): EbayListingDetails {
    if (!ld) return { startTime: '', viewItemURL: '' };
    return {
      startTime: String(ld.StartTime ?? ''),
      endTime: ld.EndTime ? String(ld.EndTime) : undefined,
      viewItemURL: String(ld.ViewItemURL ?? ''),
    };
  }

  private parseActiveItem(item: Record<string, unknown>): EbayActiveItem {
    const sellingStatus = this.parseSellingStatus(item.SellingStatus as Record<string, unknown> | undefined);
    const listingDetails = this.parseListingDetails(item.ListingDetails as Record<string, unknown> | undefined);

    return {
      itemId: String(item.ItemID ?? ''),
      title: String(item.Title ?? ''),
      sku: item.SKU ? String(item.SKU) : null,
      watchCount: Number(item.WatchCount ?? 0),
      quantitySold: sellingStatus.quantitySold,
      sellingStatus,
      listingDetails,
    };
  }

  private parseSoldItemFromTransaction(tx: Record<string, unknown>): EbaySoldItem | null {
    // Item is always an array (xml.ts isArray), take first element
    const itemArr = this.ensureArray(tx.Item);
    const item = itemArr[0] as Record<string, unknown> | undefined;
    if (!item) return null;

    const sellingStatus = this.parseSellingStatus(item.SellingStatus as Record<string, unknown> | undefined);
    const listingDetails = this.parseListingDetails(item.ListingDetails as Record<string, unknown> | undefined);

    // Parse transaction
    const txPrice = tx.TransactionPrice;
    let txPriceVal = 0;
    let txCurrency = 'USD';
    if (typeof txPrice === 'object' && txPrice != null) {
      const priceObj = txPrice as Record<string, unknown>;
      txPriceVal = Number(priceObj['#text'] ?? priceObj['__text'] ?? 0);
      txCurrency = String(priceObj['@_currencyID'] ?? 'USD');
    } else {
      txPriceVal = Number(txPrice ?? 0);
    }

    const buyer = tx.Buyer as Record<string, unknown> | undefined;

    const transaction: EbayTransaction = {
      transactionId: String(tx.TransactionID ?? ''),
      transactionPrice: txPriceVal,
      transactionPriceCurrency: txCurrency,
      createdDate: String(tx.CreatedDate ?? ''),
      buyerUserId: buyer ? String(buyer.UserID ?? '') : undefined,
      quantityPurchased: Number(tx.QuantityPurchased ?? 1),
    };

    return {
      itemId: String(item.ItemID ?? ''),
      title: String(item.Title ?? ''),
      sku: item.SKU ? String(item.SKU) : null,
      quantitySold: sellingStatus.quantitySold,
      sellingStatus,
      listingDetails,
      transactions: [transaction],
    };
  }

  private parseUnsoldItem(item: Record<string, unknown>): EbayUnsoldItem {
    const sellingStatus = this.parseSellingStatus(item.SellingStatus as Record<string, unknown> | undefined);
    const listingDetails = this.parseListingDetails(item.ListingDetails as Record<string, unknown> | undefined);

    return {
      itemId: String(item.ItemID ?? ''),
      title: String(item.Title ?? ''),
      sku: item.SKU ? String(item.SKU) : null,
      sellingStatus,
      listingDetails,
    };
  }

}
