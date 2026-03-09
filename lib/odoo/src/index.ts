// @ld/odoo-sdk — Typed Odoo client and schema for listing-dashboard

export { OdooClient, OdooClientError } from './client.js';
export type { OdooConfig, SearchReadOptions } from './client.js';

export {
  getProduct,
  getProductByCode,
  searchProducts,
  countProducts,
  writeDeviceFields,
  writeListingFields,
  writeEbayFields,
  getProductByEbayItemId,
  uploadAttachment,
  getAttachments,
  countAttachments,
  isReadyToList,
} from './products.js';
export type { Attachment } from './products.js';

export {
  CUSTOM_FIELDS,
  STANDARD_FIELDS,
  DEFAULT_PRODUCT_FIELDS,
} from './schema.js';
export type {
  OdooProduct,
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
  DeviceWritableFields,
  PhotoWritableFields,
  ListingWritableFields,
  EbayWritableFields,
} from './schema.js';
