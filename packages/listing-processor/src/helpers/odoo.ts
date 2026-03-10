// Odoo connection and image helpers.

import { OdooClient, getAttachmentsWithData, batchCountAttachments } from '@ld/odoo-sdk';
import type { OdooImage } from '@ld/odoo-sdk';

export function getOdoo(): OdooClient | null {
  try {
    return OdooClient.fromEnv();
  } catch {
    return null;
  }
}

export async function getProductImages(odoo: OdooClient, productId: number): Promise<OdooImage[]> {
  return getAttachmentsWithData(odoo, productId) as Promise<OdooImage[]>;
}

export async function getProductImageCounts(
  odoo: OdooClient,
  productIds: number[],
): Promise<Map<number, number>> {
  return batchCountAttachments(odoo, productIds);
}
