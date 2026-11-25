// Builds the Claude request and turns the reply into an AiResult (BUILD_PLAN.md §2.4 ai_client). No SDK import: the client is injected.

import type {
  AiForm, AiInput, AiOptions, AiResult, AnthropicLike, AnthropicMessageLike,
} from './types.ts';
import { AI_FORM_SCHEMA, SYSTEM_PROMPT, checkAiFormShape } from './ai_schema.ts';

const BODY_LIMIT = 24000;
const TIME_ZONE = 'Africa/Cairo';

// JSON that can never contain a raw '<', so email text cannot close a tag.
const safeJson = (x: unknown): string => JSON.stringify(x).replace(/</g, '\\u003c');

export function aiOptionsFromEnv(env: Record<string, string | undefined>): AiOptions {
  const effortRaw = env.CLAUDE_EFFORT;
  const effort: AiOptions['effort'] =
    effortRaw === 'low' || effortRaw === 'medium' || effortRaw === 'high' ? effortRaw : 'low';
  return {
    model: env.CLAUDE_MODEL || 'claude-opus-5-5',
    effort,
    maxTokens: parseInt(env.CLAUDE_MAX_TOKENS ?? '', 10) || 8000,
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
    model: opts.model,
    max_tokens: opts.maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: opts.effort, format: { type: 'json_schema', schema: AI_FORM_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
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

export async function understandEmail(client: AnthropicLike, input: AiInput, opts: AiOptions): Promise<AiResult> {
  let response: AnthropicMessageLike;
  try {
    response = await client.beta.messages.create(buildRequest(input, opts));
  } catch (err) {
    const status = errorStatus(err);
    const permanent = status !== null && status >= 400 && status <= 499 && ![408, 409, 429].includes(status);
    return { ok: false, error: 'api_error', retryable: !permanent, detail: errorMessage(err) };
  }

  if (response.stop_reason === 'refusal') {
    return {
      ok: false,
      error: 'refusal',
      retryable: false,
      detail: response.stop_details?.category ?? '',
    };
  }
  if (response.stop_reason === 'max_tokens') {
    return { ok: false, error: 'max_tokens', retryable: false, detail: 'output truncated at max_tokens' };
  }

  // With server-side fallbacks the content can hold the declining model's blocks, then a
  // {type:'fallback'} marker, then the fallback model's output. Only blocks after the last
  // marker belong to the usable turn.
  const blocks = response.content ?? [];
  let start = 0;
  for (let i = 0; i < blocks.length; i++) if (blocks[i].type === 'fallback') start = i + 1;
  const block = blocks.slice(start).find((b) => b.type === 'text');
  let parsed: unknown;
  try {
    parsed = JSON.parse(block?.text ?? '');
  } catch {
    return { ok: false, error: 'bad_output', retryable: false, detail: 'reply is not valid JSON' };
  }
  const problems = checkAiFormShape(parsed);
  if (problems.length > 0) {
    return { ok: false, error: 'bad_output', retryable: false, detail: problems.join(', ') };
  }

  return {
    ok: true,
    form: parsed as AiForm,
    model: response.model ?? opts.model,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}
