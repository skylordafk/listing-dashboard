// OdooClient — JSON-RPC client for Odoo
// Handles authentication, connection, and typed execute_kw calls.

export interface OdooConfig {
  url: string;       // e.g. 'http://192.168.1.103:8069'
  db: string;        // e.g. 'spv-oodo'
  uid: number;       // e.g. 2
  apiKey: string;    // Odoo API key
}

export interface SearchReadOptions {
  fields?: string[];
  limit?: number;
  offset?: number;
  order?: string;
}

type OdooDomain = Array<[string, string, unknown] | '|' | '&' | '!'>;

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data: { message: string; debug: string };
  };
}

export class OdooClientError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly debug?: string,
  ) {
    super(message);
    this.name = 'OdooClientError';
  }
}

const RPC_TIMEOUT_MS = 30_000;

export class OdooClient {
  private readonly url: string;
  private readonly db: string;
  private readonly uid: number;
  private readonly apiKey: string;
  private requestId = 0;

  constructor(config: OdooConfig) {
    this.url = config.url.replace(/\/$/, '');
    this.db = config.db;
    this.uid = config.uid;
    this.apiKey = config.apiKey;
  }

  /**
   * Load config from environment variables or a config file.
   * Env vars: ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY
   */
  static fromEnv(overrides?: Partial<OdooConfig>): OdooClient {
    const config: OdooConfig = {
      url: overrides?.url ?? process.env.ODOO_URL ?? 'http://192.168.1.103:8069',
      db: overrides?.db ?? process.env.ODOO_DB ?? 'spv-oodo',
      uid: overrides?.uid ?? Number(process.env.ODOO_UID ?? '2'),
      apiKey: overrides?.apiKey ?? process.env.ODOO_API_KEY ?? '',
    };
    if (!config.apiKey) {
      throw new OdooClientError('ODOO_API_KEY is required');
    }
    return new OdooClient(config);
  }

  /** Raw JSON-RPC call. */
  private async rpc<T>(service: string, method: string, args: unknown[]): Promise<T> {
    const id = ++this.requestId;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'call',
      params: { service, method, args },
    });

    const url = `${this.url}/jsonrpc`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new OdooClientError(`Odoo RPC timed out after 30s: ${url}`);
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new OdooClientError(`Odoo RPC aborted: ${url}`);
      }
      throw err;
    }

    if (!res.ok) {
      throw new OdooClientError(`HTTP ${res.status}: ${res.statusText}`);
    }

    const json = (await res.json()) as JsonRpcResponse<T>;

    if (json.error) {
      throw new OdooClientError(
        json.error.data?.message ?? json.error.message,
        json.error.code,
        json.error.data?.debug,
      );
    }

    return json.result as T;
  }

  /** Execute an Odoo model method via execute_kw. */
  async executeKw<T = unknown>(
    model: string,
    method: string,
    args: unknown[],
    kwargs?: Record<string, unknown>,
  ): Promise<T> {
    const callArgs: unknown[] = [this.db, this.uid, this.apiKey, model, method, args];
    if (kwargs) callArgs.push(kwargs);
    return this.rpc<T>('object', 'execute_kw', callArgs);
  }

  /** Search and read records. */
  async searchRead<T = Record<string, unknown>>(
    model: string,
    domain: OdooDomain,
    options?: SearchReadOptions,
  ): Promise<T[]> {
    const kwargs: Record<string, unknown> = {};
    if (options?.fields) kwargs.fields = options.fields;
    if (options?.limit !== undefined) kwargs.limit = options.limit;
    if (options?.offset !== undefined) kwargs.offset = options.offset;
    if (options?.order) kwargs.order = options.order;
    return this.executeKw<T[]>(model, 'search_read', [domain], kwargs);
  }

  /** Count records matching a domain. */
  async searchCount(model: string, domain: OdooDomain): Promise<number> {
    return this.executeKw<number>(model, 'search_count', [domain]);
  }

  /** Read specific records by ID. */
  async read<T = Record<string, unknown>>(
    model: string,
    ids: number[],
    fields?: string[],
  ): Promise<T[]> {
    const kwargs: Record<string, unknown> = {};
    if (fields) kwargs.fields = fields;
    return this.executeKw<T[]>(model, 'read', [ids], kwargs);
  }

  /** Write (update) records. */
  async write(
    model: string,
    ids: number[],
    values: Record<string, unknown>,
  ): Promise<boolean> {
    return this.executeKw<boolean>(model, 'write', [ids, values]);
  }

  /** Create a new record. Returns the new record ID. */
  async create(
    model: string,
    values: Record<string, unknown>,
  ): Promise<number> {
    return this.executeKw<number>(model, 'create', [values]);
  }

  /** Get field definitions for a model. */
  async fieldsGet(
    model: string,
    attributes?: string[],
  ): Promise<Record<string, Record<string, unknown>>> {
    const kwargs: Record<string, unknown> = {};
    if (attributes) kwargs.attributes = attributes;
    return this.executeKw(model, 'fields_get', [], kwargs);
  }

  /** Simple connectivity check. */
  async ping(): Promise<boolean> {
    try {
      const count = await this.searchCount('res.users', [['id', '=', this.uid]]);
      return count === 1;
    } catch {
      return false;
    }
  }
}
