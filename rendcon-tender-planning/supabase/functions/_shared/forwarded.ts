// Focus a forwarded Public Sector email on the one email that matters, before matching and AI.
// A forward in the user's inbox looks like: forwarder's signature, then an Outlook/Gmail header
// block (From/Sent/To/Cc/Subject) of the original, its body, and below it older quoted emails.
// The long To/Cc lists name many engineers, and the older quotes name other projects, so both
// confuse the AI. Keep only the original's From, Subject and body.

import type { MailMessage } from './types.ts';
import { isForwarded } from './prefilter.ts';
import { firstNameAr } from './arabic.ts';

const HEADER_KEY = /^[\s>*]*(from|sent|date|to|cc|bcc|subject|من|أرسل|مرسل|التاريخ|إلى|الى|نسخة|الموضوع)\s*[*]?\s*:\s*[*]?\s*(.*)$/i;
const FROM_KEY = /^(from|من)$/i;
const SUBJECT_KEY = /^(subject|الموضوع)$/i;
const SEPARATOR = /^[\s>]*(_{5,}|-{5,}.*(original|forwarded).*-{0,}|-{5,})\s*$/i;
const LINKS_BLOCK = /\n\nLinks:\n[\s\S]*$/;

interface HeaderBlock { start: number; end: number; from: string; subject: string }

const unquote = (s: string): string => s.replace(/^[\s>]+/, '');

// A header block starts at a From: line and has a Subject: line within the next 40 lines.
function headerAt(lines: string[], i: number): HeaderBlock | null {
  const first = HEADER_KEY.exec(lines[i]);
  if (!first || !FROM_KEY.test(first[1])) return null;
  for (let j = i + 1; j < Math.min(lines.length, i + 40); j += 1) {
    const h = HEADER_KEY.exec(lines[j]);
    if (h && FROM_KEY.test(h[1])) return null;
    if (h && SUBJECT_KEY.test(h[1])) {
      return { start: i, end: j, from: first[2].trim(), subject: h[2].replace(/\*+$/, '').trim() };
    }
  }
  return null;
}

function headerBlocks(lines: string[]): HeaderBlock[] {
  const out: HeaderBlock[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const b = headerAt(lines, i);
    if (b) { out.push(b); i = b.end; }
  }
  return out;
}

// Lines from..to (exclusive), dropping a trailing separator line and quote marks.
function slice(lines: string[], from: number, to: number): string {
  let end = to;
  while (end > from && (lines[end - 1].trim() === '' || SEPARATOR.test(lines[end - 1]))) end -= 1;
  return lines.slice(from, end).map(unquote).join('\n').trim();
}

export interface FocusedMail { subject: string; from: string | null; body: string }

export function focusBody(m: Pick<MailMessage, 'subject' | 'bodyText'>): FocusedMail | null {
  const text = String(m.bodyText ?? '');
  const linksBlock = LINKS_BLOCK.exec(text)?.[0] ?? '';
  const lines = text.slice(0, text.length - linksBlock.length).split(/\r?\n/);
  const blocks = headerBlocks(lines);
  if (!blocks.length) return null;
  if (isForwarded(m)) {
    const b = blocks[0];
    const next = blocks[1]?.start ?? lines.length;
    const body = slice(lines, b.end + 1, next);
    const head = `From: ${b.from}\nSubject: ${b.subject}`;
    return { subject: b.subject || m.subject, from: b.from || null, body: `${head}\n\n${body}${linksBlock}` };
  }
  // Not a forward: keep the new text and drop the older quoted emails below it.
  const body = slice(lines, 0, blocks[0].start);
  return { subject: m.subject, from: null, body: `${body}${linksBlock}` };
}

export function focusMessage(m: MailMessage): MailMessage {
  const f = focusBody(m);
  if (!f || f.body.trim() === '') return m;
  return { ...m, subject: f.subject, bodyText: f.body };
}

// «والمشرف علي الدراسة» then the first engineer's name (same line or the next non-empty line).
const SUPERVISOR = /المشرف\s+(?:عل[يى]|على)\s+(?:ال)?دراس[ةه]\s*[:：\-–]?/;
const NAME_WORD = /^[\p{L}]{2,}$/u;

export function extractSupervisor(bodyText: string): string | null {
  const text = String(bodyText ?? '');
  const hit = SUPERVISOR.exec(text);
  if (!hit) return null;
  const rest = text.slice(hit.index + hit[0].length).split(/\r?\n/);
  for (const raw of rest.slice(0, 6)) {
    const line = unquote(raw).replace(/^[\s:：\-–]+/, '').trim();
    if (line === '') continue;
    const first = firstNameAr(line).replace(/[.,،:]+$/, '');
    return NAME_WORD.test(first) ? first : null;
  }
  return null;
}

// The project name as written at the top: "New Tender Notification - <name>" in the subject,
// or «ورد الينا مناقصه جديده – <name>» / «بمشروع <name>» in the body.
const SUBJECT_NAME = /^(?:(?:re|fw|fwd)\s*:\s*)*(?:new\s+)?(?:tender|addendum|addenda|query|queries|clarifications?|notification|postponement|extension|answers?|reply)\b[^-–:]*[-–:]\s*(.+)$/i;
const BODY_NAME = /(?:مناقص[ةه]\s+جديد[ةه]|بمشروع|خاص\s+بمشروع)\s*[-–:.(]*\s*([^\n]+)/;

const tidy = (s: string): string =>
  s.replace(/^[\s\-–:.(]+/, '').replace(/[\s.)]+$/, '').replace(/\s{2,}/g, ' ').trim();

export function projectNameHint(m: Pick<MailMessage, 'subject' | 'bodyText'>): string | null {
  const s = SUBJECT_NAME.exec(String(m.subject ?? '').trim());
  if (s && tidy(s[1]).length >= 3) return tidy(s[1]).slice(0, 200);
  const b = BODY_NAME.exec(String(m.bodyText ?? ''));
  if (b && tidy(b[1]).length >= 3) return tidy(b[1]).slice(0, 200);
  return null;
}
