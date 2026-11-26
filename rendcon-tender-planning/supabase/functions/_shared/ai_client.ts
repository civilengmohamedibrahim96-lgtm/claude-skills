// Builds the Gemini request and turns the reply into an AiResult (BUILD_PLAN.md §2.4 ai_client,
// switched from Claude to Google Gemini on the AI Studio free tier). No SDK import: the client
// is injected; createGeminiClient wraps the REST API around any fetch function.

import type {
  AiForm, AiInput, AiOptions, AiResult, GeminiLike, GeminiResponseLike,
} from './types.ts';
import { extractSupervisor, projectNameHint } from './forwarded.ts';
import { AI_FORM_SCHEMA, SYSTEM_PROMPT, checkAiFormShape } from './ai_schema.ts';

const BODY_LIMIT = 24000;
const TIME_ZONE = 'Africa/Cairo';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// JSON that can never contain a raw '<', so email text cannot close a tag.
const safeJson = (x: unknown): string => JSON.stringify(x).replace(/</g, '\\u003c');

export function aiOptionsFromEnv(env: Record<string, string | undefined>): AiOptions {
  return {
    model: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    // thinking tokens count toward Gemini's output limit, so leave room above the ~1k-token form
    maxTokens: parseInt(env.GEMINI_MAX_TOKENS ?? '', 10) || 16000,
  };
}

export function buildUserPrompt(input: AiInput): string {
  const m = input.message;
  const team = input.tenderTeam.map((t) => ({ name: t.name, name_ar: t.nameAr, type: t.type }));
  const examples = input.examples.map((e) => ({
    subject: e.subject,
    excerpt: e.excerpt,
    chosen: e.chosen,
    chosen_title: e.chosenTitle,
    ai_suggestion: e.aiSuggestion,
  }));
  const shortlist = input.shortlist.map((e) => ({
    ref: e.ref,
    title: e.project.title,
    client: e.project.client,
    supervisor: e.project.supervisor,
    tender_type: e.project.tenderType,
    submission_date: e.project.dueOn,
    status: e.project.status,
    last_email_subject: e.project.lastEmailSubject,
    conversation_match: e.conversationMatch,
    similarity: e.score,
  }));
  const from = m.from ? (m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address) : null;
  const bodyText = String(m.bodyText ?? '');
  const emailJson = {
    folder: m.folder,
    subject: m.subject,
    from,
    to: m.to,
    cc: m.cc,
    date: m.date,
    has_attachments: m.hasAttachments,
    project_name_hint: projectNameHint(m),
    supervisor_hint: extractSupervisor(bodyText),
    body: bodyText.slice(0, BODY_LIMIT),
    body_truncated: bodyText.length > BODY_LIMIT,
  };
  return [
    `Today: ${input.today} (time zone ${TIME_ZONE})`,
    `<tender_team>${safeJson(team)}</tender_team>`,
    `<examples>${safeJson(examples)}</examples>`,
    `<shortlist>${safeJson(shortlist)}</shortlist>`,
    `<email_json>${safeJson(emailJson)}</email_json>`,
  ].join('\n');
}

export function buildRequest(input: AiInput, opts: AiOptions): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: buildUserPrompt(input) }] }],
    generationConfig: {
      maxOutputTokens: opts.maxTokens,
      responseMimeType: 'application/json',
      responseJsonSchema: AI_FORM_SCHEMA,
    },
  };
}

type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: string; signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// REST wrapper. A non-2xx reply throws { status, message } like an SDK error.
export function createGeminiClient(apiKey: string | undefined, fetchFn: FetchLike, timeoutMs = 35_000): GeminiLike {
  return {
    async generateContent(model, body) {
      if (!apiKey) throw new Error('GEMINI_API_KEY is not set'); // no status: retried once the key is added
      const res = await fetchFn(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      const data = await res.json().catch(() => null) as
        (GeminiResponseLike & { error?: { message?: string } }) | null;
      if (!res.ok) {
        throw Object.assign(new Error(data?.error?.message ?? `Gemini HTTP ${res.status}`), { status: res.status });
      }
      return data ?? {};
    },
  };
}

function errorStatus(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

function errorMessage(err: unknown): string {
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === 'string' ? msg : String(err);
}

// Gemini finish reasons that mean the model would not answer (safety or policy blocks).
const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);

export async function understandEmail(client: GeminiLike, input: AiInput, opts: AiOptions): Promise<AiResult> {
  let response: GeminiResponseLike;
  try {
    response = await client.generateContent(opts.model, buildRequest(input, opts));
  } catch (err) {
    const status = errorStatus(err);
    const permanent = status !== null && status >= 400 && status <= 499 && ![408, 409, 429].includes(status);
    return { ok: false, error: 'api_error', retryable: !permanent, detail: errorMessage(err) };
  }

  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) return { ok: false, error: 'refusal', retryable: false, detail: blockReason };
  const candidate = response.candidates?.[0];
  const finish = candidate?.finishReason ?? '';
  if (BLOCKED.has(finish)) return { ok: false, error: 'refusal', retryable: false, detail: finish };
  if (finish === 'MAX_TOKENS') {
    return { ok: false, error: 'max_tokens', retryable: false, detail: 'output truncated at maxOutputTokens' };
  }

  // Skip thought-summary parts; the answer is the remaining text.
  const text = (candidate?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text).join('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'bad_output', retryable: false, detail: 'reply is not valid JSON' };
  }
  const problems = checkAiFormShape(parsed);
  if (problems.length > 0) {
    return { ok: false, error: 'bad_output', retryable: false, detail: problems.join(', ') };
  }

  const u = response.usageMetadata;
  return {
    ok: true,
    form: parsed as AiForm,
    model: response.modelVersion ?? opts.model,
    inputTokens: u?.promptTokenCount ?? 0,
    outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
  };
}
