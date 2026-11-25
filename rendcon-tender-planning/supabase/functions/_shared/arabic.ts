// Arabic and general text normalisation for matching. Pure functions, no I/O.
// normalizeArabic must stay identical to the SQL function public.ar_norm (BUILD_PLAN.md §2.4, vectors §2.8).

const LETTER_MAP: Record<string, string> = {
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا',
  'ى': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي',
  '²': '2', '³': '3',
};

// Stop-words in normalised form (BUILD_PLAN.md §2.4 matchTokens).
const STOP_WORDS = new Set(
  ('مشروع مشروعات لمشروع اعمال عمليه مناقصه لمناقصه مناقصات ممارسه عامه محدوده ملحق رقم بشان بخصوص الي علي من في عن مع او و تم هذا هذه ورد الينا ينا رد توجيه السيد الساده the of and for to a an in re fw fwd')
    .split(' '),
);

function digitValue(ch: string): string | null {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 0x0660 && c <= 0x0669) return String(c - 0x0660); // Arabic-Indic
  if (c >= 0x06f0 && c <= 0x06f9) return String(c - 0x06f0); // Persian
  return null;
}

export function toAsciiDigits(s: string): string {
  return String(s ?? '').replace(/[٠-٩۰-۹]/g, (ch) => digitValue(ch) ?? ch);
}

export function normalizeArabic(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[أإآٱىةؤئ²³٠-٩۰-۹]/g, (ch) => LETTER_MAP[ch] ?? toAsciiDigits(ch))
    .replace(/[ً-ٰـ]/g, '')
    .replace(/[^0-9a-zء-ي\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchTokens(s: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of normalizeArabic(s).split(' ')) {
    let t = raw;
    if (STOP_WORDS.has(t)) continue;
    if (t.startsWith('وال') && t.length >= 5) t = t.slice(1);
    else if (t.startsWith('بال') && t.length >= 6) t = t.slice(3);
    else if (t.startsWith('ال') && t.length >= 5) t = t.slice(2);
    else if (t.startsWith('لل') && t.length >= 5) t = t.slice(2);
    if (STOP_WORDS.has(t)) continue;
    if (t.length < 2) continue;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export function trigrams(word: string): Set<string> {
  const padded = '  ' + word + ' ';
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

export function trigramSimilarity(a: string, b: string): number {
  const ga = trigrams(a);
  const gb = trigrams(b);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

const TITLE_PREFIX = /^\s*(و?المهندس[ةه]?|مهندس[ةه]?|م\s*[\/.]|eng\.?)\s*/i;

export function firstNameAr(s: string): string {
  let x = toAsciiDigits(String(s ?? '')).trim();
  // Two passes: "م/ المهندس ميريهان" needs the title removed twice.
  x = x.replace(TITLE_PREFIX, '');
  x = x.replace(TITLE_PREFIX, '');
  const first = x.trim().split(/\s+/)[0];
  return first ?? '';
}
