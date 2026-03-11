import { loadEbayConfig } from './config.js';
import { EbayApiError, EbayAuthError } from './errors.js';
import { parseXml, xmlEscape, xmlGet, xmlFindAll, safeCdata } from './xml.js';
import { EBAY_CONDITIONS } from '@ld/catalog';
import type {
  EbayConfig, ListingData, AddItemResult, VerifyAddItemResult,
  ReviseItemResult, TestConnectionResult, CategorySpecificsResult,
  CategoryAspect, Fee, ApiWarning,
} from './types.js';
import type { OdooImage } from '@ld/odoo-sdk';

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
    // Group item specifics by name for multi-value support
    const specGroups = new Map<string, string[]>();
    for (const s of data.item_specifics ?? []) {
      const existing = specGroups.get(s.Name);
      if (existing) {
        existing.push(s.Value);
      } else {
        specGroups.set(s.Name, [s.Value]);
      }
    }
    const specificsXml = [...specGroups.entries()].map(([name, values]) => {
      const valuesXml = values.map(v => `\n                <Value>${xmlEscape(v)}</Value>`).join('');
      return `\n            <NameValueList>\n                <Name>${xmlEscape(name)}</Name>${valuesXml}\n            </NameValueList>`;
    }).join('');

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
        <ConditionID>${data.condition_id ?? EBAY_CONDITIONS.used}</ConditionID>
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

}
