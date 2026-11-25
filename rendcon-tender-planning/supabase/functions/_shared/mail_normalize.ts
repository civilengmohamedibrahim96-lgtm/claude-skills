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
