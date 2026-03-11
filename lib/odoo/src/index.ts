// @ld/odoo-sdk — Typed Odoo client and schema for listing-dashboard

export { OdooClient, OdooClientError } from './client.js';
export type { OdooConfig, SearchReadOptions } from './client.js';

export {
  getProduct,
  getProductByCode,
  searchProducts,
  countProducts,
  getProductByEbayItemId,
  uploadAttachment,
  getAttachments,
  getAttachmentsWithData,
  batchCountAttachments,
  countAttachments,
  isReadyToList,
} from './products.js';
export type { Attachment, AttachmentWithData } from './products.js';

export {
  CUSTOM_FIELDS,
  STANDARD_FIELDS,
  DEFAULT_PRODUCT_FIELDS,
} from './schema.js';
export type {
  OdooProduct,
  OdooImage,
  ProductType,
  RamSize,
  StorageType,
  Condition,
  Color,
  GraphicsType,
  LaptopType,
  OperatingSystem,
  TestResult,
  EbayStatus,
} from './schema.js';
