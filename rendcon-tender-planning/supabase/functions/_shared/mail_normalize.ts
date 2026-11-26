// Turns a Microsoft Graph style message (as returned through Composio) into a MailMessage. Pure.

import type { Folder, MailAddress, MailMessage } from './types.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' };

function codePointOr(n: number, original: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : original;
}

// Single pass, so an entity is decoded exactly once.
function decodeEntities(s: string): string {
  return s.replace(/&(nbsp|amp|lt|gt|quot|#39|#x[0-9a-fA-F]+|#\d+);/g, (whole: string, body: string) => {
    if (body === '#39') return "'";
    if (body.startsWith('#x')) return codePointOr(parseInt(body.slice(2), 16), whole);
    if (body.startsWith('#')) return codePointOr(parseInt(body.slice(1), 10), whole);
    return NAMED_ENTITIES[body] ?? whole;
  });
}

export function htmlToText(html: string): string {
  let s = String(html ?? '').replace(/\r\n?/g, '\n');
  s = s
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, '');
  // Anchors: "TEXT (URL)" unless the text already contains the URL. Kept undecoded; decoded once below.
  s = s.replace(
    /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_whole: string, _quote: string, url: string, inner: string) => {
      const text = inner.replace(/<[^>]*>/g, '').trim();
      const href = url.trim();
      if (!href) return text;
      if (!text) return href;
      return text.includes(href) ? text : `${text} (${href})`;
    },
  );
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const TRAILING_PUNCT = /[.,;:!?)\]}»]+$/;

export function extractUrls(text: string, html: string | null): string[] {
  const found: string[] = [];
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'()،]+/g)) {
    found.push(m[0].replace(TRAILING_PUNCT, ''));
  }
  if (html) {
    for (const m of String(html).matchAll(/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi)) {
      found.push(m[2].replace(/&amp;/g, '&').replace(TRAILING_PUNCT, ''));
    }
  }
  return [...new Set(found)].filter((u) => /^https?:\/\/\S+$/.test(u));
}

function mailAddress(x: unknown): MailAddress | null {
  if (!isObj(x)) return null;
  const ea = isObj(x.emailAddress) ? x.emailAddress : null;
  const address = str(ea?.address)?.trim().toLowerCase();
  if (!address) return null;
  const name = str(ea?.name)?.trim() || null;
  return { name, address };
}

function recipientAddresses(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const r of list) {
    const a = mailAddress(r)?.address;
    if (a) out.push(a);
  }
  return out;
}

export function normalizeGraphMessage(raw: unknown, folder: Folder): MailMessage | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;

  const body = isObj(raw.body) ? raw.body : {};
  const content = str(body.content) ?? '';
  const isHtml = (str(body.contentType) ?? '').trim().toLowerCase() === 'html';
  let bodyText = isHtml ? htmlToText(content) : content;
  if (!bodyText) bodyText = str(raw.bodyPreview) ?? '';

  const received = str(raw.receivedDateTime) ?? '';
  const sent = str(raw.sentDateTime) ?? '';
  const created = str(raw.createdDateTime) ?? '';
  const primary = folder === 'inbox' ? received : sent;
  const secondary = folder === 'inbox' ? sent : received;

  const headers: Record<string, string> = {};
  if (Array.isArray(raw.internetMessageHeaders)) {
    for (const h of raw.internetMessageHeaders) {
      if (!isObj(h)) continue;
      const name = str(h.name);
      const value = str(h.value);
      if (name && value !== null) headers[name.trim().toLowerCase()] = value;
    }
  }

  const meetingType = (str(raw.meetingMessageType) ?? '').trim().toLowerCase();
  const isMeetingMessage =
    (str(raw['@odata.type']) ?? '').includes('eventMessage') ||
    (meetingType !== '' && meetingType !== 'none');

  return {
    id,
    conversationId: str(raw.conversationId),
    folder,
    subject: str(raw.subject) ?? '',
    from: mailAddress(raw.from) ?? mailAddress(raw.sender),
    to: recipientAddresses(raw.toRecipients),
    cc: recipientAddresses(raw.ccRecipients),
    date: primary || secondary || created || '',
    bodyText,
    bodyHtml: isHtml ? content : null,
    webLink: str(raw.webLink),
    headers,
    isMeetingMessage,
    hasAttachments: raw.hasAttachments === true,
  };
}

// ---------------------------------------------------------------- Gmail (GMAIL_FETCH_EMAILS through Composio)

// "Name <a@b.c>", "a@b.c" or "\"Last, First\" <a@b.c>" → MailAddress.
export function parseAddress(s: string): MailAddress | null {
  const text = String(s ?? '').trim();
  if (!text) return null;
  const angle = text.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (angle) {
    const name = angle[1].trim().replace(/^"(.*)"$/, '$1').trim() || null;
    return { name, address: angle[2].toLowerCase() };
  }
  const bare = text.match(/[^\s<>"',;]+@[^\s<>"',;]+/);
  return bare ? { name: null, address: bare[0].toLowerCase() } : null;
}

// Splits an address header on commas that are outside quotes and angle brackets.
export function parseAddressList(s: unknown): string[] {
  if (typeof s !== 'string') return [];
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle += 1;
    else if (ch === '>' && !quoted && angle > 0) angle -= 1;
    if ((ch === ',' || ch === ';') && !quoted && angle === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  const out: string[] = [];
  for (const p of parts) {
    const a = parseAddress(p)?.address;
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

export function decodeBase64Url(data: string): string {
  let b64 = String(data ?? '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (b64.length % 4 !== 0) b64 += '=';
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

type GmailWalk = { html: string | null; text: string | null; calendar: boolean; attachment: boolean };

function walkParts(part: unknown, acc: GmailWalk): void {
  if (!isObj(part)) return;
  const mime = (str(part.mimeType) ?? '').toLowerCase();
  const body = isObj(part.body) ? part.body : {};
  const data = str(body.data);
  const filename = str(part.filename) ?? '';
  if (filename !== '' || str(body.attachmentId)) acc.attachment = true;
  if (mime === 'text/calendar') acc.calendar = true;
  if (data && filename === '') {
    if (mime === 'text/html' && acc.html === null) acc.html = decodeBase64Url(data);
    else if (mime === 'text/plain' && acc.text === null) acc.text = decodeBase64Url(data);
  }
  if (Array.isArray(part.parts)) for (const p of part.parts) walkParts(p, acc);
}

export function normalizeGmailMessage(raw: unknown, folder: Folder): MailMessage | null {
  if (!isObj(raw)) return null;
  const id = str(raw.messageId) ?? str(raw.id);
  if (!id) return null;

  const payload = isObj(raw.payload) ? raw.payload : {};
  const headers: Record<string, string> = {};
  if (Array.isArray(payload.headers)) {
    for (const h of payload.headers) {
      if (!isObj(h)) continue;
      const name = str(h.name);
      const value = str(h.value);
      // first occurrence wins (Received etc. repeat; the top one is the newest)
      if (name && value !== null && !(name.trim().toLowerCase() in headers)) headers[name.trim().toLowerCase()] = value;
    }
  }

  const walk: GmailWalk = { html: null, text: null, calendar: false, attachment: false };
  walkParts(payload, walk);

  const bodyHtml = walk.html;
  let bodyText = str(raw.messageText) ?? '';
  if (!bodyText.trim()) bodyText = walk.text ?? (bodyHtml ? htmlToText(bodyHtml) : '');
  if (!bodyText.trim()) {
    const preview = isObj(raw.preview) ? str(raw.preview.body) : null;
    bodyText = preview ?? str(raw.snippet) ?? '';
  }
  bodyText = bodyText.replace(/\r\n?/g, '\n');
  // Gmail's plain-text part often drops the targets of HTML links; list any missing ones
  // so the AI (and the validator, which only keeps links found in the text) can see them.
  const missing = extractUrls('', bodyHtml).filter((u) => !bodyText.includes(u));
  if (missing.length > 0) bodyText = `${bodyText.trimEnd()}\n\nLinks:\n${missing.join('\n')}`;

  let date = str(raw.messageTimestamp) ?? '';
  if (!date && str(raw.internalDate)) {
    const ms = Number(raw.internalDate);
    if (Number.isFinite(ms)) date = new Date(ms).toISOString();
  }
  if (!date && headers.date) {
    const t = Date.parse(headers.date);
    if (!Number.isNaN(t)) date = new Date(t).toISOString();
  }

  const attachments = Array.isArray(raw.attachmentList) ? raw.attachmentList : [];

  return {
    id,
    conversationId: str(raw.threadId),
    folder,
    subject: str(raw.subject) ?? headers.subject ?? '',
    from: parseAddress(str(raw.sender) ?? headers.from ?? ''),
    to: parseAddressList(str(raw.to) ?? headers.to ?? ''),
    cc: parseAddressList(headers.cc ?? ''),
    date,
    bodyText,
    bodyHtml,
    webLink: str(raw.display_url) ?? `https://mail.google.com/mail/u/0/#all/${id}`,
    headers,
    isMeetingMessage: walk.calendar,
    hasAttachments: attachments.length > 0 || walk.attachment,
  };
}

export function normalizerFor(provider: 'outlook' | 'gmail'): (raw: unknown, folder: Folder) => MailMessage | null {
  return provider === 'gmail' ? normalizeGmailMessage : normalizeGraphMessage;
}
