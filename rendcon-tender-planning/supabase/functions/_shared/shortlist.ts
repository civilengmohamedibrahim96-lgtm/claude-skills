// Picks the board projects an email could belong to (BUILD_PLAN.md §2.4 shortlist). Pure.

import type { BoardProject, MailMessage, ShortlistEntry } from './types.ts';
import { matchTokens, trigrams } from './arabic.ts';

export type EmailDoc = {
  tokens: Set<string>;
  subjectTokens: Set<string>;
  gramsByToken: Map<string, Set<string>>;
};

const round2 = (x: number): number => Math.round(x * 100) / 100;

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// subject + first 8000 characters of the body
export function buildEmailDoc(m: MailMessage): EmailDoc {
  const body = String(m.bodyText ?? '').slice(0, 8000);
  const tokens = new Set(matchTokens(`${m.subject} ${body}`));
  const subjectTokens = new Set(matchTokens(m.subject));
  const gramsByToken = new Map<string, Set<string>>();
  for (const t of tokens) gramsByToken.set(t, trigrams(t));
  return { tokens, subjectTokens, gramsByToken };
}

// Share of the field's unique tokens that appear in the document (fuzzy: trigram similarity >= 0.7 counts with its value).
export function containment(fieldTokens: string[], docTokens: Set<string>, doc: EmailDoc): number {
  const unique = [...new Set(fieldTokens)];
  if (unique.length === 0) return 0;
  let sum = 0;
  for (const q of unique) {
    if (docTokens.has(q)) {
      sum += 1;
      continue;
    }
    const qGrams = trigrams(q);
    let best = 0;
    for (const d of docTokens) {
      const dGrams = doc.gramsByToken.get(d) ?? trigrams(d);
      const sim = jaccard(qGrams, dGrams);
      if (sim > best) best = sim;
    }
    if (best >= 0.7) sum += best;
  }
  return sum / unique.length;
}

export function scoreProject(p: BoardProject, doc: EmailDoc): number {
  const titleTokens = matchTokens(p.title);
  const clientTokens = matchTokens(p.client);
  const score =
    0.65 * containment(titleTokens, doc.tokens, doc) +
    0.2 * containment(clientTokens, doc.tokens, doc) +
    0.15 * (p.supervisor ? containment(matchTokens(p.supervisor), doc.tokens, doc) : 0) +
    0.1 * containment(titleTokens, doc.subjectTokens, doc);
  return round2(Math.min(1, score));
}

function compareDue(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildShortlist(
  m: MailMessage,
  projects: BoardProject[],
  conversationProjectIds: string[],
  size: number = 8,
): ShortlistEntry[] {
  const doc = buildEmailDoc(m);
  const rows = projects.map((project) => {
    const conversationMatch = conversationProjectIds.includes(project.id);
    let score = scoreProject(project, doc);
    if (conversationMatch && score < 0.95) score = 0.95;
    return { project, score: round2(score), conversationMatch };
  });
  rows.sort(
    (a, b) =>
      Number(b.conversationMatch) - Number(a.conversationMatch) ||
      b.score - a.score ||
      compareDue(a.project.dueOn, b.project.dueOn) ||
      compareText(a.project.title, b.project.title),
  );
  return rows.slice(0, size).map((r, i) => ({
    ref: 'P' + (i + 1),
    project: r.project,
    score: r.score,
    conversationMatch: r.conversationMatch,
  }));
}
