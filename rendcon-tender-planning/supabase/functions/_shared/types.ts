// Redcon Tender Planning – backend contract. Types only, no runtime code.
// Written verbatim from BUILD_PLAN.md §2.3. Import with `import type { … } from './types.ts'`.

export type IsoDate = string;      // 'YYYY-MM-DD'
export type IsoDateTime = string;  // ISO 8601, e.g. '2026-11-25T07:12:00Z'
export type Folder = 'inbox' | 'sent';
export type Direction = 'received' | 'sent';
export type TenderType = 'public' | 'private';
export type TagId = string;        // system tags: 'new' | 'upd' | 'qa' | 'pp' | 'un' | 'urgent' | 'sub'
export type Level = 'high' | 'medium' | 'low';

// ---------------------------------------------------------------- mail
export type MailAddress = { name: string | null; address: string };

export type MailMessage = {
  id: string;                        // Outlook or Gmail message id (dedupe key)
  conversationId: string | null;
  folder: Folder;
  subject: string;
  from: MailAddress | null;
  to: string[];                      // lower-case addresses
  cc: string[];
  date: IsoDateTime;                 // receivedDateTime (inbox) or sentDateTime (sent)
  bodyText: string;                  // plain text (HTML converted)
  bodyHtml: string | null;           // original HTML when the body was HTML
  webLink: string | null;            // Outlook / Gmail web link to open the original
  headers: Record<string, string>;   // lower-case header name -> value
  isMeetingMessage: boolean;
  hasAttachments: boolean;
};

export type StoredMessage = Omit<MailMessage, 'bodyHtml'>; // bodyText cut to 20000 chars

// ---------------------------------------------------------------- board (as the pipeline sees it)
export type Person = {
  id: string;
  name: string;
  email: string | null;
  role: 'admin' | 'engineer';
  active: boolean;
  prefs: { push: boolean; email: boolean };
};

export type TenderMember = { id: string; name: string; nameAr: string; type: TenderType };

export type BoardProject = {
  id: string;
  title: string;
  client: string;
  supervisor: string | null;
  tenderId: string | null;
  tenderType: TenderType;
  dueOn: IsoDate | null;
  status: string;
  tags: TagId[];
  assigneeId: string | null;
  updatedAt: IsoDateTime;
  lastEmailSubject: string | null;
};

// ---------------------------------------------------------------- prefilter / shortlist
export type PrefilterReason = 'auto_reply' | 'meeting' | 'bulk_header' | 'newsletter' | 'system_sender';
export type PrefilterResult = { skip: false; reason: null } | { skip: true; reason: PrefilterReason };

export type ShortlistEntry = {
  ref: string;                 // 'P1' … 'P8' in shortlist order
  project: BoardProject;
  score: number;               // 0..1, rounded to 2 decimals
  conversationMatch: boolean;  // email thread already linked to this project
};

// ---------------------------------------------------------------- AI form
export type ReceivedKind = 'new_project' | 'update' | 'postponed' | 'queries_answers';
export type SentKind = 'queries_sent' | 'offer_submitted' | 'extension_requested' | 'reply_or_follow_up';
export type MailKind = ReceivedKind | SentKind | 'not_a_tender';
export type ActionKind = ReceivedKind | SentKind;

export type AiLink = { url: string; label: string };

export type AiForm = {
  direction: Direction;
  kind: MailKind;
  matched_project: string;              // shortlist ref ('P3'), 'new' or 'none'
  match_reason: string;
  other_possible_projects: string[];    // shortlist refs, max 2
  project_name: string | null;
  client: string | null;
  submission_date: string | null;       // 'YYYY-MM-DD'
  submission_date_source: string | null;
  tender_type: 'public' | 'private' | 'unknown';
  supervisor_first_name: string | null;
  links: AiLink[];
  suggested_status: string | null;
  summary: string;
  confidence: { match: Level; facts: Level };
};

export type MatchExample = {
  subject: string;
  excerpt: string;                       // first 300 chars of the body
  chosen: 'existing' | 'new';
  chosenTitle: string | null;
  aiSuggestion: string | null;           // title the AI had picked, or 'new'
};

export type AiInput = {
  message: MailMessage;
  shortlist: ShortlistEntry[];
  tenderTeam: TenderMember[];
  examples: MatchExample[];
  today: IsoDate;
};

export type AiOptions = { model: string; maxTokens: number };

export type AiFailure = 'refusal' | 'max_tokens' | 'bad_output' | 'api_error';
export type AiResult =
  | { ok: true; form: AiForm; model: string; inputTokens: number; outputTokens: number }
  | { ok: false; error: AiFailure; retryable: boolean; detail: string };

// Minimal structural view of the Gemini REST API (models/{model}:generateContent) used by ai_client.ts.
// A failed call throws { status?: number, message: string }.
export type GeminiPart = { text?: string; thought?: boolean };
export type GeminiResponseLike = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string | null }[];
  promptFeedback?: { blockReason?: string | null } | null;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
};
export type GeminiLike = {
  generateContent(model: string, body: Record<string, unknown>): Promise<GeminiResponseLike>;
};

// ---------------------------------------------------------------- validator
export type ReviewReason =
  | 'unknown_project'        // AI ref not in the shortlist, or 'none' for a tender email
  | 'low_match_confidence'   // match confidence low, or medium without a thread hint
  | 'tie'                    // runners-up given and match not high
  | 'possible_duplicate'     // AI says new but a shortlist project scores >= 0.75
  | 'update_without_project' // update/postponed/… but AI says 'new'
  | 'missing_title'          // new project without a name
  | 'bad_date'               // not a real date / absurd year
  | 'past_date'              // submission date before today
  | 'low_fact_confidence'    // a date was given with facts confidence low
  | 'ai_refused'             // stop_reason refusal
  | 'ai_incomplete'          // stop_reason max_tokens
  | 'ai_bad_output';         // not valid JSON / wrong shape

export type ValidatedForm = {
  direction: Direction;                  // always from the folder, never from the AI
  kind: ActionKind;
  projectId: string | null;              // null = create a new project
  projectName: string | null;
  client: string | null;
  submissionDate: IsoDate | null;
  submissionDateSource: string | null;
  tenderType: TenderType | null;
  tenderId: string | null;
  supervisor: string | null;
  links: AiLink[];                       // only URLs that literally occur in the email
  suggestedStatus: string | null;
  summary: string;
  matchReason: string;
  confidence: { match: Level; facts: Level };
  raw: AiForm;
};

export type ValidateContext = {
  message: MailMessage;
  shortlist: ShortlistEntry[];
  tenderTeam: TenderMember[];
  today: IsoDate;
};

export type Decision =
  | { action: 'apply'; form: ValidatedForm }
  | { action: 'review'; form: ValidatedForm | null; reasons: ReviewReason[]; candidates: ShortlistEntry[] }
  | { action: 'ignore'; reason: 'not_a_tender' };

// ---------------------------------------------------------------- repository (mail side)
export type ProcessedOutcome = 'prefiltered' | 'ignored' | 'applied' | 'review' | 'error';

export type ProcessedRecord = {
  messageId: string;
  folder: Folder;
  subject: string;
  fromAddress: string | null;
  receivedAt: IsoDateTime;
  outcome: ProcessedOutcome;
  attempts: number;
  lastError: string | null;
  prefilterReason: PrefilterReason | null;
  projectId: string | null;
  mailEventId: string | null;
  reviewId: string | null;
};

export type NewProjectInput = {
  title: string;
  client: string;
  tenderType: TenderType;
  tenderId: string | null;
  supervisor: string | null;
  dueOn: IsoDate | null;
  receivedOn: IsoDate;
  status: string;
  source: 'email';
  tags: TagId[];
  updatedBy: string;                     // 'email'
};

export type ProjectPatch = {
  status?: string;
  dueOn?: IsoDate | null;
  tenderId?: string | null;
  tenderType?: TenderType;
  supervisor?: string | null;
  updatedBy: string;                     // 'email'
};

export type DateChangeInput = {
  projectId: string;
  fromDate: IsoDate | null;
  toDate: IsoDate | null;
  changedBy: string;                     // 'email'
  mailEventId: string | null;
};

export type MailEventInput = {
  projectId: string;
  messageId: string;
  folder: Folder;
  direction: Direction;
  kind: ActionKind;
  summary: string;
  subject: string;
  fromAddress: string | null;
  receivedAt: IsoDateTime;
  webLink: string | null;
  conversationId: string | null;
  linksCount: number;
  aiForm: AiForm | null;
  matchReason: string | null;
  confidence: { match: Level; facts: Level } | null;
};

export type ReviewCandidate = { projectId: string; title: string; score: number };

export type ReviewInput = {
  messageId: string;
  folder: Folder;
  message: StoredMessage;
  aiForm: AiForm | null;
  validated: ValidatedForm | null;
  candidates: ReviewCandidate[];         // max 3
  reasons: ReviewReason[];
};

export type ReviewRecord = ReviewInput & { id: string; status: 'open' | 'resolved' | 'dismissed' };

export type ReviewResolution =
  | { action: 'assign'; projectId: string }
  | { action: 'new' }
  | { action: 'dismiss' };

export type ApplyResult = { projectId: string; created: boolean; mailEventId: string; changes: string[] };

export type MailRunSummary = {
  runId: string | null;
  trigger: 'cron' | 'manual';
  skipped: null | 'already_running' | 'disabled';
  fetched: number;
  alreadyProcessed: number;
  prefiltered: number;
  aiCalls: number;
  applied: number;
  created: number;
  updated: number;
  review: number;
  ignored: number;
  errors: number;
  deferred: number;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime;
};

export interface MailRepository {
  getMailSettings(): Promise<{ hourlyEnabled: boolean; lastRunAt: IsoDateTime | null }>;
  setLastRunAt(at: IsoDateTime): Promise<void>;
  startRun(trigger: 'cron' | 'manual'): Promise<string | null>;          // null = another run is active
  finishRun(runId: string, summary: MailRunSummary, error: string | null): Promise<void>;
  getProcessed(messageIds: string[]): Promise<Map<string, ProcessedRecord>>;
  markProcessed(rec: ProcessedRecord): Promise<void>;                   // upsert by messageId
  listOpenProjects(): Promise<BoardProject[]>;                          // archived = false
  getProject(id: string): Promise<BoardProject | null>;
  findProjectIdsByConversation(conversationId: string): Promise<string[]>;
  listTenderTeam(): Promise<TenderMember[]>;
  listMatchExamples(limit: number): Promise<MatchExample[]>;            // newest first
  createProject(input: NewProjectInput): Promise<string>;               // returns id; also inserts tags
  updateProject(id: string, patch: ProjectPatch): Promise<void>;
  addTags(projectId: string, tags: TagId[]): Promise<void>;             // ignore duplicates
  addDateChange(input: DateChangeInput): Promise<void>;
  addLinks(projectId: string, links: { url: string; title: string }[], mailEventId: string | null): Promise<number>; // returns number actually added (dedupe by url)
  addMailEvent(input: MailEventInput): Promise<string>;
  addSystemComment(projectId: string, text: string): Promise<void>;     // author_name 'System', system = true
  addReview(input: ReviewInput): Promise<string>;                       // upsert by messageId, status 'open'
  getReview(id: string): Promise<ReviewRecord | null>;
  closeReview(id: string, status: 'resolved' | 'dismissed', resolvedBy: string, resolution: ReviewResolution): Promise<void>;
  addMatchExample(example: MatchExample & { reviewId: string; createdBy: string }): Promise<void>;
}

// ---------------------------------------------------------------- mail transport
export interface MailClient {
  listMessages(folder: Folder, since: IsoDateTime, max: number): Promise<unknown[]>; // raw Graph-like objects, oldest first
  getMessage(id: string): Promise<unknown>;                                          // raw Graph-like object
  sendMail(msg: { to: string; subject: string; html: string }): Promise<void>;
}

export type HttpRequest = { url: string; method: 'POST' | 'GET'; headers: Record<string, string>; body: string | null };
export type HttpResponse = { status: number; json: unknown };
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

export type MailProvider = 'outlook' | 'gmail';

export type ComposioConfig = {
  provider: MailProvider;                // COMPOSIO_PROVIDER, default 'outlook'
  baseUrl: string;
  executePath: string;                   // contains '{slug}'
  apiKey: string;
  connectedAccountId: string;
  userId: string | null;
  toolkitVersion: string | null;
  slugs: { listInbox: string; listSent: string; getMessage: string; sendMail: string };
  argMap: Record<string, Record<string, string>>;
  pageSize: number;
};

// Minimal structural view of a supabase-js client (createClient()).
export type SupabaseLike = {
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): any;
};

// ---------------------------------------------------------------- reminders
export type Repeat = 'none' | 'hourly' | 'daily' | 'weekly';
export type AutoKind = 'due3' | 'due1';

export type ReminderRow = {
  id: string;
  projectId: string | null;
  message: string;
  at: IsoDateTime;                       // exactly as read from the database
  repeat: Repeat;
  recipients: string[];                  // 'all' | 'assignee' | person id
  email: boolean;
  fired: boolean;
  createdBy: string | null;
};

export type ReminderProject = {
  id: string;
  title: string;
  dueOn: IsoDate | null;
  assigneeId: string | null;
  tags: TagId[];
  archived: boolean;
};

export type AutoReminder = {
  projectId: string;
  kind: AutoKind;
  dueOn: IsoDate;
  fireAt: IsoDateTime;
  message: string;                       // 'Submission in 3 days: …' / 'Submission tomorrow: …'
};

export type PushSubscriptionRow = { id: string; personId: string; endpoint: string; p256dh: string; auth: string };
export type PushPayload = { title: string; body: string; url: string; tag: string };
export type PushOutcome = 'ok' | 'gone' | 'error';
export interface PushSender {
  send(sub: PushSubscriptionRow, payload: PushPayload): Promise<PushOutcome>;
}

export type DeliveryRecord = {
  reminderId: string | null;
  projectId: string | null;
  autoKind: AutoKind | null;
  dueOn: IsoDate | null;
  message: string;
  recipientNames: string[];
  pushCount: number;
  emailCount: number;
  sentAt: IsoDateTime;
};

export interface ReminderRepository {
  listPeople(): Promise<Person[]>;                                        // active only
  listDueReminders(now: IsoDateTime): Promise<ReminderRow[]>;            // fired = false and at <= now
  claimReminder(id: string, expectedAt: IsoDateTime, next: { fired: true } | { at: IsoDateTime }): Promise<boolean>;
  getProject(id: string): Promise<ReminderProject | null>;
  listProjectsWithDue(fromDate: IsoDate): Promise<ReminderProject[]>;    // due_on >= fromDate, not archived
  listAutoKeys(fromDate: IsoDate): Promise<Set<string>>;                 // `${projectId}|${autoKind}|${dueOn}` with due_on >= fromDate
  claimAuto(a: AutoReminder): Promise<string | null>;                    // inserts delivery row; null if it already exists
  listPushSubscriptions(personIds: string[]): Promise<PushSubscriptionRow[]>;
  deletePushSubscription(endpoint: string): Promise<void>;
  recordDelivery(d: DeliveryRecord): Promise<string>;
  updateDelivery(id: string, d: { recipientNames: string[]; pushCount: number; emailCount: number }): Promise<void>;
}

export type NowReminderInput = { projectId: string | null; message: string; recipients: string[]; email: boolean };

export type ReminderMode =
  | { kind: 'due' }
  | { kind: 'now'; reminder: NowReminderInput; requestedBy: Person }
  | { kind: 'test'; person: Person };

export type ReminderRunSummary = {
  reminders: number;
  autoReminders: number;
  pushes: number;
  pushesFailed: number;
  emails: number;
  emailsFailed: number;
  removedSubscriptions: number;
  recipientNames: string[];              // for 'now'/'test' responses
};

// ---------------------------------------------------------------- HTTP bodies (edge functions)
export type MailSyncRequest = { source: 'cron' | 'manual' };
export type MailReviewRequest = { reviewId: string } & ReviewResolution;
export type MailReviewResponse = { ok: true; projectId: string | null } | { ok: false; error: string };
export type SendRemindersRequest = { mode: 'due' } | { mode: 'now'; reminder: NowReminderInput } | { mode: 'test' };
export type ErrorResponse = { error: 'unauthorized' | 'forbidden' | 'bad_request' | 'method_not_allowed' | 'internal'; detail?: string };
