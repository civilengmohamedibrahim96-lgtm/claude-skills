import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esc, norm, firstName, dueInfo, sortItems, SORTS, ago, folderKind, fmtDate, isoIn,
} from '../src/lib/util.js';

test('esc escapes HTML and tolerates null', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(null), '');
});

test('norm folds alef forms, ta marbuta, ya and Arabic digits', () => {
  assert.equal(norm('إأآ'), 'ااا');
  assert.equal(norm('مدرسة الأهرام ى'), 'مدرسه الاهرام ي');
  assert.equal(norm('٢٠٢٦'), '2026');
  assert.equal(norm('Boundary Wall'), 'boundary wall');
});

test('firstName strips titles', () => {
  assert.equal(firstName('م/ شيرين محمود'), 'شيرين');
  assert.equal(firstName('Eng. Mina'), 'Mina');
  assert.equal(firstName(''), '');
});

test('dueInfo for overdue, today, tomorrow, in 2 days and none', () => {
  const now = new Date(2026, 10, 25, 14, 0, 0); // 25 Nov 2026 (local)
  assert.deepEqual(dueInfo('2026-11-23', now), { cls: 'late', rel: '2 days overdue' });
  assert.deepEqual(dueInfo('2026-11-24', now), { cls: 'late', rel: '1 day overdue' });
  assert.deepEqual(dueInfo('2026-11-25', now), { cls: 'late', rel: 'Today' });
  assert.deepEqual(dueInfo('2026-11-26', now), { cls: 'soon', rel: 'Tomorrow' });
  assert.deepEqual(dueInfo('2026-11-27', now), { cls: 'soon', rel: 'In 2 days' });
  assert.deepEqual(dueInfo('2026-12-20', now), { cls: '', rel: 'In 25 days' });
  assert.deepEqual(dueInfo('', now), { cls: 'none', rel: 'Not set' });
});

test('sortItems handles every SORTS key', () => {
  const items = [
    { title: 'B', due: '2026-12-05', updatedAt: 1, received: '2026-11-01', pos: 2 },
    { title: 'A', due: '', updatedAt: 3, received: '2026-11-03', pos: 0 },
    { title: 'C', due: '2026-12-01', updatedAt: 2, received: '2026-11-02', pos: 1 },
  ];
  const titles = (k) => sortItems(items, k).map((x) => x.title).join('');
  assert.equal(titles('due'), 'CBA');
  assert.equal(titles('dueDesc'), 'BCA');
  assert.equal(titles('updated'), 'ACB');
  assert.equal(titles('received'), 'ACB');
  assert.equal(titles('name'), 'ABC');
  assert.equal(titles('manual'), 'ACB');
  for (const k of Object.keys(SORTS)) assert.equal(sortItems(items, k).length, 3);
  assert.equal(items[0].title, 'B', 'input array is not mutated');
});

test('ago formats minutes, hours, days', () => {
  const now = Date.UTC(2026, 10, 25, 12);
  assert.equal(ago(now - 10 * 1000, now), 'just now');
  assert.equal(ago(now - 5 * 60000, now), '5m ago');
  assert.equal(ago(now - 3 * 3600000, now), '3h ago');
  assert.equal(ago(now - 2 * 86400000, now), '2d ago');
  assert.equal(ago(0, now), '');
});

test('folderKind recognises SharePoint and OneDrive links only', () => {
  assert.equal(folderKind('https://redcon.sharepoint.com/sites/Tenders/x'), 'onedrive');
  assert.equal(folderKind('https://onedrive.live.com/?id=1'), 'onedrive');
  assert.equal(folderKind('https://1drv.ms/f/abc'), 'onedrive');
  assert.equal(folderKind('https://drive.google.com/drive/folders/1'), 'link');
  assert.equal(folderKind(''), 'link');
});

test('fmtDate reads YYYY-MM-DD as a calendar day', () => {
  assert.equal(fmtDate('2027-02-15'), '15 Feb 2027');
  assert.equal(fmtDate(''), '—');
});

test('isoIn returns local calendar dates', () => {
  assert.equal(isoIn(0, new Date(2026, 10, 25)), '2026-11-25');
  assert.equal(isoIn(-3, new Date(2026, 10, 25)), '2026-11-22');
  assert.equal(isoIn(14, new Date(2026, 10, 25)), '2026-12-09');
});
