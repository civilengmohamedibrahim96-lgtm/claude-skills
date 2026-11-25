import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildShortlist, containment, buildEmailDoc, scoreProject } from '../../functions/_shared/shortlist.ts';
import { normalizeGraphMessage } from '../../functions/_shared/mail_normalize.ts';
import { matchTokens } from '../../functions/_shared/arabic.ts';
import type { BoardProject, MailMessage } from '../../functions/_shared/types.ts';

const board = JSON.parse(readFileSync(new URL('../fixtures/board.json', import.meta.url), 'utf8'));
const projects: BoardProject[] = board.projects;

const fixture = (name: string): any =>
  JSON.parse(readFileSync(new URL(`../fixtures/emails/${name}.json`, import.meta.url), 'utf8'));

function shortlistFor(name: string) {
  const f = fixture(name);
  const m = normalizeGraphMessage(f.raw, f.folder)!;
  return buildShortlist(m, projects, m.conversationId ? board.conversations[m.conversationId] ?? [] : []);
}

test('fixture 02 (postponed tank) → P1 is p-tank', () => {
  assert.equal(shortlistFor('02-postponed')[0].project.id, 'p-tank');
});

test('fixture 03 (answers in an existing thread) → P1 is p-elec, conversation match, score ≥ 0.95', () => {
  const top = shortlistFor('03-queries-answers')[0];
  assert.equal(top.project.id, 'p-elec');
  assert.equal(top.conversationMatch, true);
  assert.ok(top.score >= 0.95);
});

test('fixture 04 (sent queries) → P1 is p-sewer', () => {
  assert.equal(shortlistFor('04-queries-sent')[0].project.id, 'p-sewer');
});

test('fixture 05 (offer for boundary wall) → P1 is p-wall', () => {
  assert.equal(shortlistFor('05-offer-submitted')[0].project.id, 'p-wall');
});

test('fixture 07 (ambiguous roads) → p-roads2 and p-roads3 are in the first 3', () => {
  const top3 = shortlistFor('07-ambiguous-roads').slice(0, 3).map((e) => e.project.id);
  assert.ok(top3.includes('p-roads2'), top3.join(','));
  assert.ok(top3.includes('p-roads3'), top3.join(','));
});

test('fixture 01 (new tender) → no board project scores 0.75 or more', () => {
  const list = shortlistFor('01-new-tender');
  assert.ok(list.every((e) => e.score < 0.75), JSON.stringify(list.map((e) => [e.project.id, e.score])));
});

test('default size is 8, refs run P1…P8 in order, and scores have 2 decimals', () => {
  const f = fixture('07-ambiguous-roads');
  const m = normalizeGraphMessage(f.raw, f.folder)!;
  const list = buildShortlist(m, projects, []);
  assert.equal(list.length, 8);
  assert.deepEqual(list.map((e) => e.ref), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
  for (const e of list) assert.equal(Math.round(e.score * 100) / 100, e.score);
});

test('a small board fills the list with zero-score projects', () => {
  const f = fixture('01-new-tender');
  const m = normalizeGraphMessage(f.raw, f.folder)!;
  const list = buildShortlist(m, projects.slice(0, 3), []);
  assert.equal(list.length, 3);
});

test('conversation matches sort first and lift the score to at least 0.95', () => {
  const f = fixture('01-new-tender');
  const m = normalizeGraphMessage(f.raw, f.folder)!;
  const list = buildShortlist(m, projects, ['p-wall']);
  assert.equal(list[0].project.id, 'p-wall');
  assert.equal(list[0].conversationMatch, true);
  assert.equal(list[0].score, 0.95);
});

test('containment: exact token hit counts 1, unrelated tokens count 0', () => {
  const m: MailMessage = {
    id: 'c', conversationId: null, folder: 'inbox', subject: 'خزان', from: null, to: [], cc: [], date: '',
    bodyText: 'خزان مياه', bodyHtml: null, webLink: null, headers: {}, isMeetingMessage: false, hasAttachments: false,
  };
  const doc = buildEmailDoc(m);
  assert.equal(containment([], doc.tokens, doc), 0);
  assert.equal(containment(matchTokens('خزان'), doc.tokens, doc), 1);
  assert.equal(containment(matchTokens('مبنى'), doc.tokens, doc), 0);
  assert.equal(containment(matchTokens('خزان مبنى'), doc.tokens, doc), 0.5);
});

test('scoreProject is capped at 1 and rounded to 2 decimals', () => {
  const m: MailMessage = {
    id: 'c', conversationId: null, folder: 'inbox', subject: 'Boundary wall gatehouse', from: null, to: [], cc: [], date: '',
    bodyText: 'Boundary wall gatehouse Education Directorate', bodyHtml: null, webLink: null, headers: {},
    isMeetingMessage: false, hasAttachments: false,
  };
  const p = projects.find((x) => x.id === 'p-wall')!;
  const s = scoreProject({ ...p, supervisor: 'Boundary' }, buildEmailDoc(m));
  assert.ok(s <= 1);
  assert.equal(Math.round(s * 100) / 100, s);
});
