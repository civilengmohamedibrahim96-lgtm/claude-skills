// In-memory MailRepository for tests and the pipeline integration test.
import type {
  BoardProject,
  DateChangeInput,
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
  TagId,
  TenderMember,
  IsoDateTime,
} from './types.ts';

export type MemorySeed = {
  projects: BoardProject[];
  tenderTeam: TenderMember[];
  conversations?: Record<string, string[]>;
  examples?: MatchExample[];
  lastRunAt?: IsoDateTime | null;
  hourlyEnabled?: boolean;
};

export type MemoryState = {
  projects: BoardProject[];
  mailEvents: (MailEventInput & { id: string })[];
  links: { projectId: string; url: string; title: string }[];
  dateChanges: DateChangeInput[];
  comments: { projectId: string; text: string }[];
  reviews: ReviewRecord[];
  processed: Map<string, ProcessedRecord>;
  runs: { id: string; summary: MailRunSummary | null; error: string | null }[];
  examples: MatchExample[];
  lastRunAt: IsoDateTime | null;
};

function copyProject(p: BoardProject): BoardProject {
  return { ...p, tags: [...p.tags] };
}

export function createMemoryMailRepository(seed: MemorySeed): MailRepository & { dump(): MemoryState } {
  const projects: BoardProject[] = seed.projects.map(copyProject);
  const tenderTeam: TenderMember[] = seed.tenderTeam.map((t) => ({ ...t }));
  const conversations = new Map<string, Set<string>>();
  for (const [conv, ids] of Object.entries(seed.conversations ?? {})) {
    conversations.set(conv, new Set(ids));
  }
  const examples: MatchExample[] = (seed.examples ?? []).map((e) => ({ ...e }));
  const mailEvents: (MailEventInput & { id: string })[] = [];
  const links: { projectId: string; url: string; title: string }[] = [];
  const dateChanges: DateChangeInput[] = [];
  const comments: { projectId: string; text: string }[] = [];
  const reviews: ReviewRecord[] = [];
  const processed = new Map<string, ProcessedRecord>();
  const runs: { id: string; summary: MailRunSummary | null; error: string | null }[] = [];
  const settingsHourly = seed.hourlyEnabled ?? true;
  let lastRunAt: IsoDateTime | null = seed.lastRunAt ?? null;
  const counters = { project: 0, event: 0, review: 0, run: 0 };
  const nowIso = (): IsoDateTime => new Date().toISOString();

  const findProject = (id: string): BoardProject | undefined => projects.find((p) => p.id === id);

  return {
    async getMailSettings() {
      return { hourlyEnabled: settingsHourly, lastRunAt };
    },

    async setLastRunAt(at) {
      lastRunAt = at;
    },

    async startRun(_trigger) {
      if (runs.some((r) => r.summary === null)) return null;
      counters.run += 1;
      const id = `mem-run-${counters.run}`;
      runs.push({ id, summary: null, error: null });
      return id;
    },

    async finishRun(runId, summary, error) {
      const run = runs.find((r) => r.id === runId);
      if (run) {
        run.summary = summary;
        run.error = error;
      }
    },

    async getProcessed(messageIds) {
      const out = new Map<string, ProcessedRecord>();
      for (const id of messageIds) {
        const rec = processed.get(id);
        if (rec) out.set(id, { ...rec });
      }
      return out;
    },

    async markProcessed(rec) {
      processed.set(rec.messageId, { ...rec });
    },

    async listOpenProjects() {
      return projects.map(copyProject);
    },

    async getProject(id) {
      const p = findProject(id);
      return p ? copyProject(p) : null;
    },

    async findProjectIdsByConversation(conversationId) {
      const ids = new Set<string>(conversations.get(conversationId) ?? []);
      for (const e of mailEvents) {
        if (e.conversationId === conversationId) ids.add(e.projectId);
      }
      return [...ids];
    },

    async listTenderTeam() {
      return tenderTeam.map((t) => ({ ...t }));
    },

    async listMatchExamples(limit) {
      return examples.slice(0, limit).map((e) => ({ ...e }));
    },

    async createProject(input: NewProjectInput) {
      counters.project += 1;
      const id = `mem-p-${counters.project}`;
      projects.push({
        id,
        title: input.title,
        client: input.client,
        supervisor: input.supervisor,
        tenderId: input.tenderId,
        tenderType: input.tenderType,
        dueOn: input.dueOn,
        status: input.status,
        tags: [...input.tags],
        assigneeId: null,
        updatedAt: nowIso(),
        lastEmailSubject: null,
      });
      return id;
    },

    async updateProject(id, patch: ProjectPatch) {
      const p = findProject(id);
      if (!p) throw new Error('project not found');
      if (patch.status !== undefined) p.status = patch.status;
      if (patch.dueOn !== undefined) p.dueOn = patch.dueOn;
      if (patch.tenderId !== undefined) p.tenderId = patch.tenderId;
      if (patch.tenderType !== undefined) p.tenderType = patch.tenderType;
      if (patch.supervisor !== undefined) p.supervisor = patch.supervisor;
      p.updatedAt = nowIso();
    },

    async addTags(projectId, tags: TagId[]) {
      const p = findProject(projectId);
      if (!p) throw new Error('project not found');
      for (const t of tags) {
        if (!p.tags.includes(t)) p.tags.push(t);
      }
    },

    async addDateChange(input) {
      dateChanges.push({ ...input });
    },

    async addLinks(projectId, newLinks, _mailEventId) {
      let added = 0;
      for (const l of newLinks) {
        if (links.some((x) => x.projectId === projectId && x.url === l.url)) continue;
        links.push({ projectId, url: l.url, title: l.title });
        added += 1;
      }
      return added;
    },

    async addMailEvent(input) {
      counters.event += 1;
      const id = `mem-e-${counters.event}`;
      mailEvents.push({ ...input, id });
      const p = findProject(input.projectId);
      if (p) {
        p.lastEmailSubject = input.subject;
        p.updatedAt = nowIso();
      }
      return id;
    },

    async addSystemComment(projectId, text) {
      comments.push({ projectId, text });
    },

    async addReview(input: ReviewInput) {
      const existing = reviews.find((r) => r.messageId === input.messageId);
      if (existing) {
        Object.assign(existing, { ...input, status: 'open' as const });
        return existing.id;
      }
      counters.review += 1;
      const id = `mem-r-${counters.review}`;
      reviews.push({ ...input, id, status: 'open' });
      return id;
    },

    async getReview(id) {
      const r = reviews.find((x) => x.id === id);
      return r ? { ...r } : null;
    },

    async closeReview(id, status, _resolvedBy, _resolution: ReviewResolution) {
      const r = reviews.find((x) => x.id === id);
      if (r) r.status = status;
    },

    async addMatchExample(example) {
      examples.unshift({
        subject: example.subject,
        excerpt: example.excerpt,
        chosen: example.chosen,
        chosenTitle: example.chosenTitle,
        aiSuggestion: example.aiSuggestion,
      });
    },

    dump(): MemoryState {
      return {
        projects: projects.map(copyProject),
        mailEvents: mailEvents.map((e) => ({ ...e })),
        links: links.map((l) => ({ ...l })),
        dateChanges: dateChanges.map((d) => ({ ...d })),
        comments: comments.map((c) => ({ ...c })),
        reviews: reviews.map((r) => ({ ...r })),
        processed: new Map([...processed].map(([k, v]) => [k, { ...v }])),
        runs: runs.map((r) => ({ ...r })),
        examples: examples.map((e) => ({ ...e })),
        lastRunAt,
      };
    },
  };
}
