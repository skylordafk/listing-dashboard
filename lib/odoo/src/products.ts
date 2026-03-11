// Product operations — typed CRUD for product.product

import { OdooClient, SearchReadOptions } from './client.js';
import {
  OdooProduct,
  DEFAULT_PRODUCT_FIELDS,
} from './schema.js';

type OdooDomain = Array<[string, string, unknown] | '|' | '&' | '!'>;

// ── Read Operations ─────────────────────────────────────────────────

/** Get a single product by ID. */
export async function getProduct(
  client: OdooClient,
  id: number,
  fields?: string[],
): Promise<OdooProduct | null> {
  const results = await client.read<OdooProduct>(
    'product.product',
    [id],
    fields ?? [...DEFAULT_PRODUCT_FIELDS],
  );
  return results[0] ?? null;
}

/** Get a product by its internal reference (default_code / asset ID). */
export async function getProductByCode(
  client: OdooClient,
  code: string,
  fields?: string[],
): Promise<OdooProduct | null> {
  const results = await client.searchRead<OdooProduct>(
    'product.product',
    [['default_code', '=', code]],
    { fields: fields ?? [...DEFAULT_PRODUCT_FIELDS], limit: 1 },
  );
  return results[0] ?? null;
}

/** Search products with a domain filter. */
export async function searchProducts(
  client: OdooClient,
  domain: OdooDomain = [],
  options?: SearchReadOptions,
): Promise<OdooProduct[]> {
  return client.searchRead<OdooProduct>(
    'product.product',
    domain,
    {
      fields: options?.fields ?? [...DEFAULT_PRODUCT_FIELDS],
      ...options,
    },
  );
}

/** Count products matching a domain. */
export async function countProducts(
  client: OdooClient,
  domain: OdooDomain = [],
): Promise<number> {
  return client.searchCount('product.product', domain);
}

// ── Attachment Operations ────────────────────────────────────────────

export interface Attachment {
  id: number;
  name: string;
  mimetype: string;
  file_size: number;
  create_date: string;
}

export interface AttachmentWithData {
  id: number;
  name: string;
  mimetype: string;
  datas: string;
}

/** Upload an image attachment to a product template. */
export async function uploadAttachment(
  client: OdooClient,
  productTemplateId: number,
  name: string,
  base64Data: string,
  mimetype: string = 'image/jpeg',
): Promise<number> {
  return client.create('ir.attachment', {
    name,
    type: 'binary',
    datas: base64Data,
    res_model: 'product.template',
    res_id: productTemplateId,
    mimetype,
  });
}

/** List attachments for a product template. */
export async function getAttachments(
  client: OdooClient,
  productTemplateId: number,
): Promise<Attachment[]> {
  return client.searchRead<Attachment>(
    'ir.attachment',
    [
      ['res_model', '=', 'product.template'],
      ['res_id', '=', productTemplateId],
      ['mimetype', 'like', 'image/'],
    ],
    { fields: ['id', 'name', 'mimetype', 'file_size', 'create_date'] },
  );
}

/** List attachments for a product template, including base64 image data. */
export async function getAttachmentsWithData(
  client: OdooClient,
  productTemplateId: number,
): Promise<AttachmentWithData[]> {
  return client.searchRead<AttachmentWithData>(
    'ir.attachment',
    [
      ['res_model', '=', 'product.template'],
      ['res_id', '=', productTemplateId],
      ['mimetype', 'like', 'image/'],
    ],
    { fields: ['id', 'datas', 'name', 'mimetype'] },
  );
}

/**
 * Count image attachments for each product template in a batch.
 * Returns a Map from product template ID to attachment count.
 */
export async function batchCountAttachments(
  client: OdooClient,
  productTemplateIds: number[],
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (productTemplateIds.length === 0) return result;

  const attachments = await client.searchRead<{ res_id: number }>(
    'ir.attachment',
    [
      ['res_model', '=', 'product.template'],
      ['res_id', 'in', productTemplateIds],
      ['mimetype', 'like', 'image/'],
    ],
    { fields: ['res_id'] },
  );

  for (const att of attachments) {
    result.set(att.res_id, (result.get(att.res_id) ?? 0) + 1);
  }
  return result;
}

/** Count image attachments for a product template. */
export async function countAttachments(
  client: OdooClient,
  productTemplateId: number,
): Promise<number> {
  return client.searchCount('ir.attachment', [
    ['res_model', '=', 'product.template'],
    ['res_id', '=', productTemplateId],
    ['mimetype', 'like', 'image/'],
  ]);
}

// ── Business Logic ───────────────────────────────────────────────────

/**
 * Check if a product has all required fields populated for eBay listing.
 * Single source of truth — import this everywhere.
 */
export function isReadyToList(product: OdooProduct, imageCount?: number): boolean {
  return !!(
    product.name &&
    product.x_brand &&
    product.x_model_name &&
    product.x_processor &&
    product.x_ram_size &&
    product.x_storage_capacity &&
    product.x_condition &&
    (imageCount === undefined || imageCount > 0)
  );
}

/** Get a product by its eBay Item ID. */
export async function getProductByEbayItemId(
  client: OdooClient,
  ebayItemId: string,
  fields?: string[],
): Promise<OdooProduct | null> {
  const results = await client.searchRead<OdooProduct>(
    'product.product',
    [['x_ebay_item_id', '=', ebayItemId]],
    { fields: fields ?? [...DEFAULT_PRODUCT_FIELDS], limit: 1 },
  );
  return results[0] ?? null;
}
