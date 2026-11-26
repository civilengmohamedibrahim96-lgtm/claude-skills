// Checks the AI form against the board and decides apply / review / ignore (BUILD_PLAN.md §2.4 validator). Pure.

import { extractSupervisor } from './forwarded.ts';
import type {
  ActionKind, AiForm, AiLink, Decision, ReviewReason,
  ShortlistEntry, TenderMember, TenderType, ValidateContext, ValidatedForm,
} from './types.ts';
import { firstNameAr, normalizeArabic } from './arabic.ts';

const RECEIVED_KINDS: ActionKind[] = ['new_project', 'update', 'postponed', 'queries_answers'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isRealIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const cap = (s: string, max: number): string => s.slice(0, max);
// trimmed and capped; null when empty
const trimCapOrNull = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : cap(t, max);
};

function memberMatchesSupervisor(member: TenderMember, supervisor: string): boolean {
  const target = normalizeArabic(supervisor);
  const byArabic = normalizeArabic(firstNameAr(member.nameAr));
  const latinName = member.name.replace(/^\s*eng\.?\s*/i, '');
  const byEnglish = normalizeArabic(firstNameAr(latinName));
  return byArabic === target || byEnglish === target;
}

export function validateForm(form: AiForm, ctx: ValidateContext): Decision {
  // 1. not a tender at all
  if (form.kind === 'not_a_tender') return { action: 'ignore', reason: 'not_a_tender' };

  const reasons: ReviewReason[] = [];
  const addReason = (r: ReviewReason): void => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  // 2. direction comes from the folder; fix up kinds that do not fit it
  const direction = ctx.message.folder === 'inbox' ? 'received' : 'sent';
  let kind = form.kind as ActionKind;
  if (direction === 'received' && !RECEIVED_KINDS.includes(kind)) kind = 'update';
  if (direction === 'sent' && RECEIVED_KINDS.includes(kind)) kind = 'reply_or_follow_up';

  // 3. project
  const ref = form.matched_project.trim();
  let projectId: string | null = null;
  let matched: ShortlistEntry | null = null;
  if (ref === 'new') {
    projectId = null;
  } else {
    matched = ctx.shortlist.find((e) => e.ref === ref) ?? null;
    if (matched) projectId = matched.project.id;
    else addReason('unknown_project');
  }

  // 4. runners-up: known refs other than the matched one, max 2
  const others: ShortlistEntry[] = [];
  for (const r of form.other_possible_projects) {
    const key = r.trim();
    if (key === ref) continue;
    const entry = ctx.shortlist.find((e) => e.ref === key);
    if (entry && !others.includes(entry)) others.push(entry);
    if (others.length === 2) break;
  }

  // 5. a new_project that matches a board project is an update
  if (projectId !== null && kind === 'new_project') kind = 'update';

  // 6. no project
  if (projectId === null && !reasons.includes('unknown_project')) {
    if (kind !== 'new_project') {
      addReason('update_without_project');
    } else {
      if (!(form.project_name ?? '').trim()) addReason('missing_title');
      if (ctx.shortlist.some((e) => e.score >= 0.75)) addReason('possible_duplicate');
    }
  }

  // 7. match confidence
  if (form.confidence.match === 'low') addReason('low_match_confidence');
  if (form.confidence.match === 'medium' && projectId !== null && matched && !matched.conversationMatch) {
    addReason('low_match_confidence');
  }

  // 8. ties
  if (others.length > 0 && form.confidence.match !== 'high') addReason('tie');

  // 9. dates. An empty date counts as no date.
  let submissionDate: string | null = (form.submission_date ?? '').trim() || null;
  if (submissionDate !== null) {
    const year = Number(submissionDate.slice(0, 4));
    const todayYear = Number(ctx.today.slice(0, 4));
    if (!isRealIsoDate(submissionDate) || year < todayYear - 1 || year > todayYear + 3) {
      addReason('bad_date');
      submissionDate = null;
    } else if (submissionDate < ctx.today) {
      addReason('past_date');
    }
    if (form.confidence.facts === 'low') addReason('low_fact_confidence');
  }

  // 10. links: only http(s) URLs that literally occur in the email
  const bodyBlob = [ctx.message.bodyText, ctx.message.bodyHtml ?? '', ctx.message.subject].join('\n');
  const links: AiLink[] = [];
  for (const l of form.links) {
    const url = l.url.trim();
    if (!/^https?:\/\//i.test(url) || !bodyBlob.includes(url)) continue;
    if (links.some((x) => x.url === url)) continue;
    links.push({ url, label: cap(l.label.trim(), 40) || 'Link' });
    if (links.length === 20) break;
  }

  // 11. supervisor and tender team
  // The first engineer after «المشرف علي الدراسة» wins over the AI's reading.
  const written = extractSupervisor(ctx.message.bodyText);
  const supervisorFirst = written
    ?? (form.supervisor_first_name ? firstNameAr(form.supervisor_first_name) : '');
  const supervisor = supervisorFirst || null;
  let tenderId: string | null = null;
  let tenderType: TenderType | null = null;
  const member = supervisor ? ctx.tenderTeam.find((t) => memberMatchesSupervisor(t, supervisor)) : undefined;
  if (member) {
    tenderId = member.id;
    tenderType = member.type;
  } else {
    tenderType = form.tender_type === 'unknown' ? null : form.tender_type;
  }

  // 12. trim and cap text fields
  const validated: ValidatedForm = {
    direction,
    kind,
    projectId,
    projectName: trimCapOrNull(form.project_name, 300),
    client: trimCapOrNull(form.client, 200),
    submissionDate,
    submissionDateSource: trimCapOrNull(form.submission_date_source, 400),
    tenderType,
    tenderId,
    supervisor,
    links,
    suggestedStatus: trimCapOrNull(form.suggested_status, 160),
    summary: trimCapOrNull(form.summary, 160) ?? 'Email received',
    matchReason: cap(form.match_reason.trim(), 400),
    confidence: { match: form.confidence.match, facts: form.confidence.facts },
    raw: form,
  };

  // 13. review or apply
  if (reasons.length === 0) return { action: 'apply', form: validated };

  const candidates: ShortlistEntry[] = [];
  const pushCandidate = (e: ShortlistEntry): void => {
    if (candidates.length < 3 && !candidates.includes(e)) candidates.push(e);
  };
  if (matched) pushCandidate(matched);
  for (const e of others) pushCandidate(e);
  for (const e of ctx.shortlist) pushCandidate(e);
  return { action: 'review', form: validated, reasons, candidates };
}
