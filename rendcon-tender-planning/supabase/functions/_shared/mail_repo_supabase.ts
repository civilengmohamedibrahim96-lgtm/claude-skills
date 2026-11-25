// MailRepository on an injected supabase-js client (service role, edge functions only).
// Column mapping is explicit per table; every { error } becomes a thrown Error.
import type {
  BoardProject,
  DateChangeInput,
  Folder,
  IsoDateTime,
  MailEventInput,
  MailRepository,
  MailRunSummary,
  MatchExample,
  NewProjectInput,
  ProcessedRecord,
  ProjectPatch,
  ReviewInput,
  ReviewRecord,
  ReviewResolution,
  SupabaseLike,
  TagId,
  TenderMember,
} from './types.ts';

type Result = { data?: any; error?: { message: string } | null };

function check(res: Result | null | undefined): any {
  if (!res) throw new Error('empty database response');
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

const PROJECT_SELECT =
  'id, title, client, supervisor, tender_id, tender_type, due_on, status, assignee_id, updated_at, project_tags(tag_id), mail_events(subject, created_at)';

const PROCESSED_SELECT =
  'message_id, folder, subject, from_address, received_at, outcome, attempts, last_error, prefilter_reason, project_id, mail_event_id, review_id';

function toBoardProject(row: any): BoardProject {
  const events: { subject: string; created_at: string }[] = Array.isArray(row.mail_events) ? row.mail_events : [];
  let latest: { subject: string; created_at: string } | null = null;
  for (const e of events) {
    if (!latest || Date.parse(e.created_at) > Date.parse(latest.created_at)) latest = e;
  }
  const tags: TagId[] = Array.isArray(row.project_tags) ? row.project_tags.map((t: any) => t.tag_id) : [];
  return {
    id: row.id,
    title: row.title,
    client: row.client ?? '',
    supervisor: row.supervisor ?? null,
    tenderId: row.tender_id ?? null,
    tenderType: row.tender_type,
    dueOn: row.due_on ?? null,
    status: row.status ?? '',
    tags,
    assigneeId: row.assignee_id ?? null,
    updatedAt: row.updated_at,
    lastEmailSubject: latest ? latest.subject : null,
  };
}

function toProcessed(row: any): ProcessedRecord {
  return {
    messageId: row.message_id,
    folder: row.folder as Folder,
    subject: row.subject ?? '',
    fromAddress: row.from_address ?? null,
    receivedAt: row.received_at ?? '',
    outcome: row.outcome,
    attempts: row.attempts ?? 0,
    lastError: row.last_error ?? null,
    prefilterReason: row.prefilter_reason ?? null,
    projectId: row.project_id ?? null,
    mailEventId: row.mail_event_id ?? null,
    reviewId: row.review_id ?? null,
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createSupabaseMailRepository(client: SupabaseLike): MailRepository {
  const from = (table: string) => client.from(table);

  return {
    async getMailSettings() {
      const rows: any[] = check(await from('settings').select('key, value').in('key', ['mail', 'mail_state']));
      const mail = rows.find((r) => r.key === 'mail')?.value ?? {};
      const state = rows.find((r) => r.key === 'mail_state')?.value ?? {};
      return {
        hourlyEnabled: mail.hourlyEnabled !== false,
        lastRunAt: typeof state.lastRunAt === 'string' ? state.lastRunAt : null,
      };
    },

    async setLastRunAt(at: IsoDateTime) {
      check(await from('settings').upsert(
        { key: 'mail_state', value: { lastRunAt: at }, updated_at: new Date().toISOString(), updated_by: 'email' },
        { onConflict: 'key' },
      ));
    },

    async startRun(trigger) {
      const data = check(await client.rpc('rpc_start_mail_run', { p_trigger: trigger }));
      return typeof data === 'string' ? data : null;
    },

    async finishRun(runId: string, summary: MailRunSummary, error: string | null) {
      check(await from('mail_runs')
        .update({ finished_at: new Date().toISOString(), summary, error })
        .eq('id', runId));
    },

    async getProcessed(messageIds: string[]) {
      const out = new Map<string, ProcessedRecord>();
      for (const part of chunks(messageIds, 100)) {
        if (part.length === 0) continue;
        const rows: any[] = check(await from('processed_messages').select(PROCESSED_SELECT).in('message_id', part));
        for (const row of rows ?? []) {
          const rec = toProcessed(row);
          out.set(rec.messageId, rec);
        }
      }
      return out;
    },

    async markProcessed(rec: ProcessedRecord) {
      check(await from('processed_messages').upsert({
        message_id: rec.messageId,
        folder: rec.folder,
        subject: rec.subject,
        from_address: rec.fromAddress,
        received_at: rec.receivedAt,
        outcome: rec.outcome,
        attempts: rec.attempts,
        last_error: rec.lastError,
        prefilter_reason: rec.prefilterReason,
        project_id: rec.projectId,
        mail_event_id: rec.mailEventId,
        review_id: rec.reviewId,
        processed_at: new Date().toISOString(),
      }, { onConflict: 'message_id' }));
    },

    async listOpenProjects() {
      const rows: any[] = check(await from('projects').select(PROJECT_SELECT).eq('archived', false));
      return (rows ?? []).map(toBoardProject);
    },

    async getProject(id: string) {
      const row = check(await from('projects').select(PROJECT_SELECT).eq('id', id).maybeSingle());
      return row ? toBoardProject(row) : null;
    },

    async findProjectIdsByConversation(conversationId: string) {
      const rows: any[] = check(await from('mail_events').select('project_id').eq('conversation_id', conversationId));
      return [...new Set((rows ?? []).map((r) => r.project_id as string))];
    },

    async listTenderTeam() {
      const rows: any[] = check(await from('tender_team').select('id, name, name_ar, type').order('sort', { ascending: true }));
      return (rows ?? []).map((r): TenderMember => ({
        id: r.id,
        name: r.name,
        nameAr: r.name_ar ?? '',
        type: r.type,
      }));
    },

    async listMatchExamples(limit: number) {
      const rows: any[] = check(await from('match_examples')
        .select('subject, excerpt, chosen, chosen_title, ai_suggestion')
        .order('created_at', { ascending: false })
        .limit(limit));
      return (rows ?? []).map((r): MatchExample => ({
        subject: r.subject ?? '',
        excerpt: r.excerpt ?? '',
        chosen: r.chosen,
        chosenTitle: r.chosen_title ?? null,
        aiSuggestion: r.ai_suggestion ?? null,
      }));
    },

    async createProject(input: NewProjectInput) {
      const row = check(await from('projects').insert({
        title: input.title,
        client: input.client,
        tender_type: input.tenderType,
        tender_id: input.tenderId,
        supervisor: input.supervisor,
        due_on: input.dueOn,
        received_on: input.receivedOn,
        status: input.status,
        source: input.source,
        updated_by: input.updatedBy,
      }).select('id').single());
      const id: string = row.id;
      if (input.tags.length > 0) {
        check(await from('project_tags').insert(input.tags.map((t) => ({ project_id: id, tag_id: t }))));
      }
      return id;
    },

    async updateProject(id: string, patch: ProjectPatch) {
      const row: Record<string, unknown> = { updated_by: patch.updatedBy };
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.dueOn !== undefined) row.due_on = patch.dueOn;
      if (patch.tenderId !== undefined) row.tender_id = patch.tenderId;
      if (patch.tenderType !== undefined) row.tender_type = patch.tenderType;
      if (patch.supervisor !== undefined) row.supervisor = patch.supervisor;
      check(await from('projects').update(row).eq('id', id));
    },

    async addTags(projectId: string, tags: TagId[]) {
      if (tags.length === 0) return;
      check(await from('project_tags').upsert(
        tags.map((t) => ({ project_id: projectId, tag_id: t })),
        { onConflict: 'project_id,tag_id', ignoreDuplicates: true },
      ));
    },

    async addDateChange(input: DateChangeInput) {
      check(await from('date_changes').insert({
        project_id: input.projectId,
        from_date: input.fromDate,
        to_date: input.toDate,
        changed_by: input.changedBy,
        mail_event_id: input.mailEventId,
      }));
    },

    async addLinks(projectId: string, links: { url: string; title: string }[], mailEventId: string | null) {
      if (links.length === 0) return 0;
      const rows: any[] = check(await from('links').upsert(
        links.map((l) => ({
          project_id: projectId,
          title: l.title,
          url: l.url,
          source: 'email',
          mail_event_id: mailEventId,
        })),
        { onConflict: 'project_id,url', ignoreDuplicates: true },
      ).select('id'));
      return (rows ?? []).length;
    },

    async addMailEvent(input: MailEventInput) {
      const row = check(await from('mail_events').insert({
        project_id: input.projectId,
        message_id: input.messageId,
        folder: input.folder,
        direction: input.direction,
        kind: input.kind,
        summary: input.summary,
        subject: input.subject,
        from_address: input.fromAddress,
        received_at: input.receivedAt,
        web_link: input.webLink,
        conversation_id: input.conversationId,
        links_count: input.linksCount,
        ai_form: input.aiForm,
        match_reason: input.matchReason,
        confidence: input.confidence,
      }).select('id').single());
      return row.id as string;
    },

    async addSystemComment(projectId: string, text: string) {
      check(await from('comments').insert({
        project_id: projectId,
        author_name: 'System',
        body: text,
        system: true,
      }));
    },

    async addReview(input: ReviewInput) {
      const row = check(await from('review_queue').upsert({
        message_id: input.messageId,
        folder: input.folder,
        message: input.message,
        ai_form: input.aiForm,
        validated: input.validated,
        candidates: input.candidates,
        reasons: input.reasons,
        status: 'open',
        resolved_by: null,
        resolved_at: null,
        resolution: null,
      }, { onConflict: 'message_id' }).select('id').single());
      return row.id as string;
    },

    async getReview(id: string) {
      const row = check(await from('review_queue')
        .select('id, message_id, folder, message, ai_form, validated, candidates, reasons, status')
        .eq('id', id)
        .maybeSingle());
      if (!row) return null;
      const review: ReviewRecord = {
        id: row.id,
        messageId: row.message_id,
        folder: row.folder,
        message: row.message,
        aiForm: row.ai_form ?? null,
        validated: row.validated ?? null,
        candidates: row.candidates ?? [],
        reasons: row.reasons ?? [],
        status: row.status,
      };
      return review;
    },

    async closeReview(id: string, status: 'resolved' | 'dismissed', resolvedBy: string, resolution: ReviewResolution) {
      check(await from('review_queue').update({
        status,
        resolved_by: resolvedBy,
        resolved_at: new Date().toISOString(),
        resolution,
      }).eq('id', id));
    },

    async addMatchExample(example: MatchExample & { reviewId: string; createdBy: string }) {
      check(await from('match_examples').insert({
        review_id: example.reviewId,
        subject: example.subject,
        excerpt: example.excerpt,
        chosen: example.chosen,
        chosen_title: example.chosenTitle,
        ai_suggestion: example.aiSuggestion,
        created_by: example.createdBy,
      }));
    },
  };
}
