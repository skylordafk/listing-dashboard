import type { FastifyInstance } from 'fastify';
import { EbayClient } from '@ld/ebay-client';
import { sendEbayError } from '../helpers/ebay-errors.js';

export default async function (app: FastifyInstance) {
  app.post('/api/test-connection', async (_req, reply) => {
    try {
      const ebay = new EbayClient();
      const result = await ebay.testConnection();
      return result;
    } catch (err) {
      return sendEbayError(reply, err);
    }
  });
}
