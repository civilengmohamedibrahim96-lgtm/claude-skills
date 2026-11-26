import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toAsciiDigits, normalizeArabic, matchTokens, trigramSimilarity, firstNameAr,
} from '../../functions/_shared/arabic.ts';

test('toAsciiDigits maps Arabic-Indic and Persian digits', () => {
  assert.equal(toAsciiDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  assert.equal(toAsciiDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
  assert.equal(toAsciiDigits('abc 42'), 'abc 42');
});

test('normalizeArabic matches the §2.8 vectors', () => {
  const vectors: [string, string][] = [
    ['إنشاء خزانُ مياه أرضي سعة ٥٠٠٠ م³ – (المرحلة) ـــ', 'انشاء خزان مياه ارضي سعه 5000 م3 المرحله'],
    ['ورد إلينا – مناقصة عامة: إنشاء مبنى إداري', 'ورد الينا مناقصه عامه انشاء مبني اداري'],
    ['Boundary Wall & Gatehouse', 'boundary wall gatehouse'],
    ['والمشرف علي الدراسه : م/ شيرين محمود', 'والمشرف علي الدراسه م شيرين محمود'],
    ['آخر موعد للتقديم: ٢٠/١٢/٢٠٢٦', 'اخر موعد للتقديم 20 12 2026'],
    ['مؤسسة الأهرام — ١٠٠٪', 'موسسه الاهرام 100'],
  ];
  for (const [input, expected] of vectors) assert.equal(normalizeArabic(input), expected, input);
});

test('normalizeArabic tolerates null-ish input', () => {
  assert.equal(normalizeArabic(undefined as unknown as string), '');
  assert.equal(normalizeArabic(null as unknown as string), '');
});

test('matchTokens matches the §2.4 vectors', () => {
  assert.deepEqual(matchTokens('إنشاء خزان مياه أرضي سعة 5000 م³'), ['انشاء', 'خزان', 'مياه', 'ارضي', 'سعه', '5000', 'م3']);
  assert.deepEqual(matchTokens('خزان أرضي للمياه بسعة ٥٠٠٠ متر مكعب'), ['خزان', 'ارضي', 'مياه', 'بسعه', '5000', 'متر', 'مكعب']);
  assert.deepEqual(matchTokens('مشروع إعادة تأهيل الطرق الداخلية'), ['اعاده', 'تاهيل', 'طرق', 'داخليه']);
});

test('matchTokens article rules', () => {
  assert.deepEqual(matchTokens('الطرق'), ['طرق']);
  assert.deepEqual(matchTokens('للمياه'), ['مياه']);
  assert.deepEqual(matchTokens('بالمنطقة'), ['منطقه']);
  assert.deepEqual(matchTokens('الحي'), ['الحي']);
  assert.deepEqual(matchTokens('والمشرف'), ['المشرف']);
});

test('matchTokens removes duplicates and empties', () => {
  assert.deepEqual(matchTokens('خزان خزان  , ,  a'), ['خزان']);
  assert.deepEqual(matchTokens(''), []);
});

test('trigramSimilarity', () => {
  assert.equal(trigramSimilarity('خزان', 'خزان'), 1);
  assert.ok(trigramSimilarity('انشاء', 'بانشاء') < 0.7);
  assert.ok(trigramSimilarity('خزان', 'مبنى') < 0.2);
});

test('firstNameAr strips titles and returns the first word', () => {
  assert.equal(firstNameAr('م/ شيرين محمود'), 'شيرين');
  assert.equal(firstNameAr('المهندسة ميريهان علي'), 'ميريهان');
  assert.equal(firstNameAr('Eng. Mina Adel'), 'Mina');
  assert.equal(firstNameAr('م/ المهندس أحمد علي'), 'أحمد');
  assert.equal(firstNameAr('شيرين'), 'شيرين');
  assert.equal(firstNameAr('   '), '');
  assert.equal(firstNameAr('٢٠'), '20');
});
