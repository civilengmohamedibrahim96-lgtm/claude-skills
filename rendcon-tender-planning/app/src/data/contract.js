// Redcon Tender Planning – frontend data-layer contract.
// Written verbatim from BUILD_PLAN.md §2.7. Both src/data/mock.js and src/data/supabase.js implement it.

/**
 * @typedef {'public'|'private'} TenderType
 * @typedef {'none'|'hourly'|'daily'|'weekly'} Repeat
 * @typedef {'new_project'|'update'|'postponed'|'queries_answers'|'queries_sent'|'offer_submitted'|'extension_requested'|'reply_or_follow_up'} MailKind
 *
 * @typedef {{browser:boolean, email:boolean}} Prefs
 * @typedef {{id:string, name:string, email:string, role:'admin'|'engineer', color:string, status:'active', prefs:Prefs, hasColumn:boolean, order:number}} User
 * @typedef {{id:string, name:string, ar:string, type:TenderType}} TenderMember
 * @typedef {{id:string, name:string, color:string}} Tag
 * @typedef {{id:string, text:string, done:boolean, note:string, due:string}} Subtask            // due: '' or 'YYYY-MM-DD'
 * @typedef {{id:string, title:string, url:string, src:boolean}} Link                             // src: true when added from an email
 * @typedef {{id:string, who:string, text:string, at:number, sys:boolean}} Comment                // at: epoch ms
 * @typedef {{from:string, to:string, by:string, at:number}} DueChange                            // from/to: '' or 'YYYY-MM-DD'; by: 'email' or a person's name
 * @typedef {{id:string, at:number, emailAt:number, kind:MailKind, direction:'received'|'sent', summary:string, subject:string, links:number, webLink:string}} MailLogItem
 * @typedef {{id:string, at:number, msg:string, repeat:Repeat, fired:boolean, to:string[], email:boolean, projectId:string|null}} Reminder // to: 'all' | 'assignee' | user id
 * @typedef {{
 *   id:string, title:string, client:string, ref:string, type:TenderType, tender:string|null, supervisor:string,
 *   columnId:string|null, pos:number, status:string, received:string, due:string, folder:string,
 *   source:'manual'|'email', subOpen:boolean, updatedAt:number, updatedBy:string, mailSeen:number,
 *   tags:string[], subtasks:Subtask[], links:Link[], comments:Comment[],
 *   dueHistory:DueChange[], mailLog:MailLogItem[], notifications:Reminder[]
 * }} Project   // dueHistory, mailLog: newest first. comments: oldest first. subtasks: by position. mailSeen: the signed-in user's last view (ms), 0 = never
 * @typedef {{id:string, msg:string, project:string, names:string[], email:number, at:number}} SentLogItem
 * @typedef {'prefiltered'|'ignored'|'applied'|'review'|'error'} MailOutcome
 * @typedef {{id:string, subject:string, from:string, at:number, outcome:MailOutcome, label:string, pid:string|null}} MailLogRow // id = Outlook message id
 * @typedef {{pid:string, title:string, score:number}} ReviewCandidate
 * @typedef {{id:string, subject:string, from:string, at:number, excerpt:string, summary:string, kind:string, title:string, reasons:string[], candidates:ReviewCandidate[], webLink:string}} ReviewItem
 * @typedef {{at:number, trigger:'cron'|'manual', fetched:number, created:number, updated:number, review:number, prefiltered:number, ignored:number, errors:number}} MailRun
 * @typedef {{address:string, subject:string, hourly:boolean, lastSync:number|null, runs:MailRun[], log:MailLogRow[], reviews:ReviewItem[]}} MailState
 * @typedef {{
 *   mode:'mock'|'supabase', me:User|null, users:User[], tenderTeam:TenderMember[], tags:Tag[],
 *   projects:Project[], reminders:Reminder[], sentLog:SentLogItem[], mail:MailState, folders:{root:string}
 * }} BoardState  // users: active team ordered by `order`; reminders: general ones only (projectId null); sentLog: newest 10; mail.log: newest 30; mail.runs: newest 5; mail.reviews: open only, newest first
 * @typedef {{table:string, type:'INSERT'|'UPDATE'|'DELETE'|'FIRED', record?:object}} ChangeEvent
 *   // 'FIRED' (mock only): a reminder fired in this browser; record = {title, body, projectId}
 */

/** Every data layer exposes exactly these async methods (all return Promises except subscribe/onAuthChange). */
export const DATA_LAYER_METHODS = [
  // auth
  'init',                  // () → {signedIn:boolean}                       mock: always {signedIn:true}
  'getSession',            // () → {email:string}|null
  'signIn',                // (email, password) → {ok:true}|{ok:false, error:string}
  'signUp',                // (email, password) → {ok:true, needsConfirmation:boolean}|{ok:false, error:string}
  'signOut',               // () → void
  'requestPasswordReset',  // (email) → {ok:boolean, error?:string}
  'updatePassword',        // (password) → {ok:boolean, error?:string}
  'onAuthChange',          // (cb:(event:'SIGNED_IN'|'SIGNED_OUT'|'PASSWORD_RECOVERY'|'OTHER')=>void) → unsubscribe()   (sync)
  // board
  'loadBoard',             // () → BoardState
  'subscribe',             // (cb:(evt:ChangeEvent)=>void) → unsubscribe()   (sync)
  // projects
  'createProject',         // ({title, tender:string|null, type, due:string, client:string, columnId:string|null}) → id
  'updateProject',         // (id, patch: subset of {title, client, ref, type, tender, supervisor, status, received, folder, subOpen}) → void
  'deleteProject',         // (id) → void
  'moveProject',           // (id, columnId|null, orderedIds:string[]) → void     orderedIds = target column ids in final order, incl. id
  'setDueDate',            // (id, due:string) → boolean changed                   '' clears the date
  'toggleTag',             // (id, tagId, on:boolean) → void
  'markMailSeen',          // (id) → void
  'createTag',             // (name) → Tag
  // sub-tasks, links, comments
  'addSubtask',            // (projectId, {text, due}) → id
  'updateSubtask',         // (id, patch: subset of {text, done, note, due}) → void
  'deleteSubtask',         // (id) → void
  'addLink',               // (projectId, {title, url}) → id
  'deleteLink',            // (id) → void
  'addComment',            // (projectId, text) → id
  // reminders
  'addReminder',           // ({projectId:string|null, at:number, msg, repeat, to:string[], email:boolean}) → id
  'deleteReminder',        // (id) → void
  'sendReminderNow',       // ({projectId:string|null, msg, to:string[], email:boolean}) → {names:string[], emails:number}
  'sendTestNotification',  // () → void
  // team (admin)
  'addPerson',             // ({name, email, role, hasColumn}) → {ok:true, id}|{ok:false, error:'missing_name'|'invalid_email'|'duplicate_email'}
  'updatePerson',          // (id, patch: subset of {name, email, role, color, prefs}) → void   non-admins: own name/color/prefs only
  'removePerson',          // (id) → void
  'reorderPeople',         // (ids:string[]) → void
  'setColumn',             // (userId, on:boolean) → void
  'addTenderMember',       // ({name, ar, type}) → id
  'updateTenderMember',    // (id, patch: subset of {name, ar, type}) → void
  'removeTenderMember',    // (id) → void
  'updateSettings',        // (patch: subset of {address, subject, hourly, folderRoot}) → void   (admin)
  // email
  'syncMailNow',           // () → {read:number, created:number, updated:number, review:number}
  'resolveReview',         // (reviewId, {action:'assign', projectId}|{action:'new'}|{action:'dismiss'}) → {projectId:string|null}
  // push
  'savePushSubscription',  // (subscriptionJSON: {endpoint, keys:{p256dh, auth}}) → void
  'deletePushSubscription',// (endpoint) → void
  // demo only
  'resetDemo',             // () → void      supabase layer: throws Error('Not available')
];

/** Exact system-comment texts (author 'System', sys:true). Dates formatted as '03 Dec 2026' (en-GB day 2-digit, month short, year). */
export const SYSTEM_TEXT = {
  created: 'Project created manually',
  assigned: (name) => `Assigned to ${name}`,
  unassigned: 'Moved back to unassigned',
  dueSet: (to) => `Submission date set to ${to}`,
  dueChanged: (from, to) => `Submission date changed from ${from} to ${to}`,
  dueCleared: 'Submission date cleared',
  status: (s) => `Status: ${s}`,
  tender: (t) => (t ? `Tender team: ${t.name} (${t.type})` : 'Tender team: not set'),
  folder: (url) => `Folder linked: ${url}`,
};

/** Card log labels and CSS classes (k-new, k-upd, k-pp, k-qa exist in the prototype CSS; k-sent is added). */
export const KIND_LABELS = {
  new_project: ['New project', 'k-new'],
  update: ['New update', 'k-upd'],
  postponed: ['Postponed', 'k-pp'],
  queries_answers: ['Queries answers', 'k-qa'],
  queries_sent: ['Queries sent', 'k-sent'],
  offer_submitted: ['Offer submitted', 'k-sent'],
  extension_requested: ['Extension requested', 'k-sent'],
  reply_or_follow_up: ['Sent reply', 'k-sent'],
};

/** Plain-English reasons shown in "Needs review". */
export const REVIEW_REASON_LABELS = {
  unknown_project: 'The AI could not tie it to a board project',
  low_match_confidence: 'Not sure which project this is',
  tie: 'Two projects fit about equally well',
  possible_duplicate: 'Looks new, but a similar project is already on the board',
  update_without_project: 'An update for a project that is not on the board',
  missing_title: 'New tender without a project name',
  bad_date: 'The date in the email could not be read',
  past_date: 'The submission date is in the past',
  low_fact_confidence: 'The date or details are unclear',
  ai_refused: 'The AI declined to read this email',
  ai_incomplete: 'The AI answer was cut off',
  ai_bad_output: 'The AI answer could not be read',
};

/** Labels for the email intake log (mail sheet). */
export const OUTCOME_LABELS = {
  prefiltered: 'Skipped – not about tenders',
  ignored: 'Ignored – not a tender email',
  applied: 'Added to the board',
  review: 'Needs review',
  error: 'Error – will retry',
};

/** Throws if `layer` misses a method. Used by both data layers' tests. */
export function assertDataLayer(layer) {
  const missing = DATA_LAYER_METHODS.filter((m) => typeof layer[m] !== 'function');
  if (missing.length) throw new Error('Data layer is missing: ' + missing.join(', '));
  return true;
}
