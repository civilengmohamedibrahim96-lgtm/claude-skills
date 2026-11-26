// Cheap rules that skip mail before any AI call (BUILD_PLAN.md §2.4 prefilter).

import type { MailMessage, PrefilterReason, PrefilterResult } from './types.ts';
import { normalizeArabic } from './arabic.ts';

const MEETING_PREFIXES = [
  'accepted:', 'declined:', 'tentative:', 'canceled:', 'cancelled:', 'updated invitation', 'invitation:',
];

const AUTO_SUBJECT_PREFIXES = [
  'automatic reply', 'auto reply', 'autoreply', 'out of office', 'رد تلقائي', 'خارج المكتب',
  'undeliverable', 'delivery status notification', 'mail delivery failed',
].map(normalizeArabic);

const SYSTEM_LOCAL_PART = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|newsletter|news|marketing|notifications?)$/i;

// Phrases are compared after normalizeArabic, as substrings of the normalised subject + body.
const NEWSLETTER_MARKERS = [
  'newsletter', 'webinar', 'unsubscribe', 'النشره', 'الغاء الاشتراك', 'اشترك الان',
].map(normalizeArabic);

const TENDER_MARKERS = [
  'مناقصه', 'عطاء', 'عطاءات', 'ممارسه', 'ورد الينا', 'استفسار', 'تاجيل', 'كراسه الشروط',
  'جداول الكميات', 'مظاريف', 'tender', 'boq', 'rfq', 'bid',
].map(normalizeArabic);

const NOT_SKIPPED = (): PrefilterResult => ({ skip: false, reason: null });
const SKIP = (reason: PrefilterReason): PrefilterResult => ({ skip: true, reason });

// Senders whose inbox mail is always read (sent to the AI), also when the mail was
// forwarded to the mailbox: default the Public Sector team's domain redconcon.com, plus the
// app's active people. Entries are full addresses or domains (subdomains included).
export const DEFAULT_ALWAYS_READ = ['redconcon.com'];
export function parseSenderList(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(/[\s,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, '').replace(/^\.+/, ''))
    .filter((d) => d !== '' && d.includes('.'));
}

export function isAlwaysReadSender(address: string | null | undefined, senders: string[]): boolean {
  const addr = String(address ?? '').trim().toLowerCase();
  const domain = addr.split('@')[1] ?? '';
  if (!domain) return false;
  return senders.some((e) => (e.includes('@') ? addr === e : domain === e || domain.endsWith(`.${e}`)));
}

const FORWARD_SUBJECT = /^\s*((re|fw|fwd|tr|wg)\s*:\s*)*(fw|fwd|tr|wg|إعادة توجيه|اعاده توجيه)\s*:/i;
const FORWARD_BODY = /(-{2,}\s*forwarded message\s*-{2,}|-{2,}\s*original message\s*-{2,}|begin forwarded message|الرسالة الأصلية|رسالة معاد توجيهها)/i;
// "From: Name <a@b.c>", "*From:* a@b.c", "من: ..." lines of a forwarded block
const FORWARD_FROM_LINE = /^[\s>*]*(from|من|de|von)\s*[*]?\s*:\s*[*]?(.*)$/gim;
const EMAIL = /[^\s<>"'(),;:\[\]]+@[^\s<>"'(),;:\[\]]+\.[a-z]{2,}/gi;

export function isForwarded(m: Pick<MailMessage, 'subject' | 'bodyText'>): boolean {
  return FORWARD_SUBJECT.test(m.subject) || FORWARD_BODY.test(m.bodyText);
}

// Original senders named in the forwarded part of the body (lower-case, in order).
export function forwardedSenders(bodyText: string): string[] {
  const out: string[] = [];
  for (const line of String(bodyText ?? '').matchAll(FORWARD_FROM_LINE)) {
    for (const a of line[2].matchAll(EMAIL)) {
      const addr = a[0].toLowerCase().replace(/^mailto:/, '');
      if (!out.includes(addr)) out.push(addr);
    }
  }
  return out;
}

export type PrefilterOptions = { alwaysReadSenders?: string[] };

function fromAlwaysRead(m: MailMessage, senders: string[]): boolean {
  if (senders.length === 0) return false;
  if (isAlwaysReadSender(m.from?.address, senders)) return true;
  // decided by sender only: any From: line in the body (a forwarded original), whatever the subject
  return forwardedSenders(m.bodyText).some((a) => isAlwaysReadSender(a, senders));
}

// Mail from an always-read sender skips the bulk/system/newsletter/meeting rules; only
// automatic replies / out-of-office notices from them are still skipped.
export function createPrefilter(opts: PrefilterOptions = {}): (m: MailMessage) => PrefilterResult {
  const senders = opts.alwaysReadSenders ?? [];
  return (m) => {
    if (m.folder === 'inbox' && fromAlwaysRead(m, senders)) {
      const r = prefilter(m);
      return r.skip && r.reason === 'auto_reply' ? r : NOT_SKIPPED();
    }
    return prefilter(m);
  };
}

export function prefilter(m: MailMessage): PrefilterResult {
  const headers = m.headers;
  const has = (name: string): boolean => Object.hasOwn(headers, name);

  // 1. meeting
  const subjectLower = m.subject.trim().toLowerCase();
  if (m.isMeetingMessage || MEETING_PREFIXES.some((p) => subjectLower.startsWith(p))) return SKIP('meeting');

  // 2. auto_reply (both folders)
  const autoSubmitted = has('auto-submitted') ? headers['auto-submitted'].trim().toLowerCase() : null;
  if ((autoSubmitted !== null && autoSubmitted !== 'no') || has('x-autoreply') || has('x-autorespond')) {
    return SKIP('auto_reply');
  }
  const subjectNorm = normalizeArabic(m.subject);
  if (AUTO_SUBJECT_PREFIXES.some((p) => subjectNorm.startsWith(p))) return SKIP('auto_reply');

  // Rules 3-5 apply to the inbox only: sent mail is never skipped by them.
  if (m.folder !== 'inbox') return NOT_SKIPPED();

  // 3. bulk_header
  const precedence = (headers.precedence ?? '').trim().toLowerCase();
  if (has('list-unsubscribe') || has('list-id') || ['bulk', 'list', 'junk'].includes(precedence)) {
    return SKIP('bulk_header');
  }

  // 4. system_sender
  const localPart = (m.from?.address ?? '').split('@')[0];
  if (localPart && SYSTEM_LOCAL_PART.test(localPart)) return SKIP('system_sender');

  // 5. newsletter, unless the text also talks about a tender
  const text = normalizeArabic(`${m.subject}\n${m.bodyText}`);
  if (NEWSLETTER_MARKERS.some((k) => text.includes(k)) && !TENDER_MARKERS.some((k) => text.includes(k))) {
    return SKIP('newsletter');
  }

  return NOT_SKIPPED();
}
