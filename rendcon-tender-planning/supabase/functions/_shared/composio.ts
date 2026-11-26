// Composio REST client for the Outlook tenders mailbox. All I/O goes through the
// injected HttpTransport, so this module runs unchanged in Deno and in node --test.
import type {
  ComposioConfig,
  Folder,
  HttpTransport,
  IsoDateTime,
  MailClient,
} from './types.ts';

export class ComposioError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ComposioError';
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

function isObject(x: unknown): x is Record<string, any> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function dig(root: Record<string, any>, a: string, b: string): unknown {
  const first = root[a];
  return isObject(first) ? first[b] : undefined;
}

export function composioConfigFromEnv(env: Record<string, string | undefined>): ComposioConfig {
  const apiKey = (env.COMPOSIO_API_KEY ?? '').trim();
  if (apiKey === '') throw new Error('COMPOSIO_API_KEY is not set');
  const connectedAccountId = (env.COMPOSIO_CONNECTED_ACCOUNT_ID ?? '').trim();
  if (connectedAccountId === '') throw new Error('COMPOSIO_CONNECTED_ACCOUNT_ID is not set');

  let argMap: Record<string, Record<string, string>> = {};
  const rawMap = (env.COMPOSIO_ARG_MAP ?? '').trim();
  if (rawMap !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMap);
    } catch {
      throw new Error('COMPOSIO_ARG_MAP is not valid JSON');
    }
    if (!isObject(parsed)) throw new Error('COMPOSIO_ARG_MAP must be a JSON object');
    argMap = parsed as Record<string, Record<string, string>>;
  }

  const pageSize = Math.floor(Number(env.COMPOSIO_PAGE_SIZE));
  return {
    baseUrl: (env.COMPOSIO_BASE_URL || 'https://backend.composio.dev/api/v3.1').trim().replace(/\/+$/, ''),
    executePath: env.COMPOSIO_EXECUTE_PATH || '/tools/execute/{slug}',
    apiKey,
    connectedAccountId,
    userId: (env.COMPOSIO_USER_ID ?? '').trim() || null,
    toolkitVersion: (env.COMPOSIO_TOOLKIT_VERSION ?? '').trim() || null,
    slugs: {
      listInbox: env.COMPOSIO_SLUG_LIST_INBOX || 'OUTLOOK_LIST_MESSAGES',
      listSent: env.COMPOSIO_SLUG_LIST_SENT || 'OUTLOOK_LIST_SENT_ITEMS_MESSAGES',
      getMessage: env.COMPOSIO_SLUG_GET_MESSAGE || 'OUTLOOK_GET_MESSAGE',
      sendMail: env.COMPOSIO_SLUG_SEND || 'OUTLOOK_SEND_EMAIL',
    },
    argMap,
    pageSize: pageSize > 0 ? pageSize : 25,
  };
}

export function renameArgs(
  slug: string,
  args: Record<string, unknown>,
  argMap: ComposioConfig['argMap'],
): Record<string, unknown> {
  const map = Object.prototype.hasOwnProperty.call(argMap, slug) ? argMap[slug] : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const renamed = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : key;
    out[renamed] = value;
  }
  return out;
}

export function extractList(data: unknown): unknown[] {
  if (isObject(data)) {
    const candidates: unknown[] = [
      data.value,
      dig(data, 'response_data', 'value'),
      dig(data, 'data', 'value'),
      data.messages,
      dig(data, 'response_data', 'messages'),
    ];
    for (const c of candidates) {
      if (Array.isArray(c)) return c;
    }
  }
  if (Array.isArray(data)) return data;
  throw new ComposioError('unexpected list shape', 200);
}

export function extractObject(data: unknown): unknown {
  if (isObject(data)) {
    for (const c of [data.response_data, data.data, data]) {
      if (isObject(c) && 'id' in c) return c;
    }
  }
  throw new ComposioError('unexpected object shape', 200);
}

export function createComposioMailClient(cfg: ComposioConfig, transport: HttpTransport): MailClient {
  async function call(slug: string, args: Record<string, unknown>): Promise<unknown> {
    const body: Record<string, unknown> = { connected_account_id: cfg.connectedAccountId };
    if (cfg.userId) body.user_id = cfg.userId;
    if (cfg.toolkitVersion) body.version = cfg.toolkitVersion;
    body.arguments = renameArgs(slug, args, cfg.argMap);

    const res = await transport({
      url: cfg.baseUrl + cfg.executePath.replace('{slug}', slug),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey },
      body: JSON.stringify(body),
    });

    const payload: any = res.json;
    if (res.status < 200 || res.status > 299) {
      const detail = isObject(payload) && typeof payload.error === 'string' ? `: ${payload.error}` : '';
      throw new ComposioError(`Composio ${slug} failed with HTTP ${res.status}${detail}`, res.status);
    }
    if (isObject(payload) && (payload.successful === false || (payload.error !== undefined && payload.error !== null && payload.error !== '' && payload.error !== false))) {
      const message = typeof payload.error === 'string' && payload.error !== '' ? payload.error : `Composio ${slug} reported failure`;
      throw new ComposioError(message, 200);
    }
    return isObject(payload) ? payload.data : undefined;
  }

  async function listMessages(folder: Folder, since: IsoDateTime, max: number): Promise<unknown[]> {
    const slug = folder === 'inbox' ? cfg.slugs.listInbox : cfg.slugs.listSent;
    const pageSize = cfg.pageSize;
    const out: unknown[] = [];
    let skip = 0;
    while (out.length < max) {
      const args: Record<string, unknown> = folder === 'inbox'
        ? { folder: 'inbox', top: pageSize, skip, filter: `receivedDateTime ge ${since}`, orderby: 'receivedDateTime asc' }
        : { top: pageSize, skip, filter: `sentDateTime ge ${since}`, orderby: 'sentDateTime asc' };
      const page = extractList(await call(slug, args));
      out.push(...page.slice(0, max - out.length));
      if (page.length < pageSize) break;
      skip += pageSize;
    }
    return out;
  }

  async function getMessage(id: string): Promise<unknown> {
    return extractObject(await call(cfg.slugs.getMessage, { message_id: id }));
  }

  async function sendMail(msg: { to: string; subject: string; html: string }): Promise<void> {
    await call(cfg.slugs.sendMail, { to_email: msg.to, subject: msg.subject, body: msg.html, is_html: true });
  }

  return { listMessages, getMessage, sendMail };
}
