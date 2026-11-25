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
