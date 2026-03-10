import type { FastifyInstance } from 'fastify';
import { EbayClient, EbayApiError, EbayAuthError } from '@ld/ebay-client';

export default async function (app: FastifyInstance) {
  app.post('/api/test-connection', async (_req, reply) => {
    try {
      const ebay = new EbayClient();
      const result = await ebay.testConnection();
      return result;
    } catch (err) {
      if (err instanceof EbayAuthError) return reply.code(401).send({ status: 'error', error: err.message, type: 'auth' });
      if (err instanceof EbayApiError) return reply.code(502).send({ status: 'error', error: err.message });
      return reply.code(500).send({ status: 'error', error: (err as Error).message });
    }
  });
}
