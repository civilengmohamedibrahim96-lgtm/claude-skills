// ReminderRepository on a supabase-js client (injected; the edge function passes createClient(...) with the service role).
import type {
  AutoReminder,
  DeliveryRecord,
  IsoDate,
  IsoDateTime,
  Person,
  PushSubscriptionRow,
  ReminderProject,
  ReminderRepository,
  ReminderRow,
  SupabaseLike,
} from './types.ts';

// Awaits a supabase-js builder and throws on error; returns its data.
async function run(builder: any): Promise<any> {
  const res = await builder;
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

function mapPerson(row: any): Person {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    role: row.role,
    active: row.active,
    prefs: { push: row.prefs?.push ?? true, email: row.prefs?.email ?? true },
  };
}

function mapProject(row: any): ReminderProject {
  return {
    id: row.id,
    title: row.title,
    dueOn: row.due_on ?? null,
    assigneeId: row.assignee_id ?? null,
    tags: (row.project_tags ?? []).map((t: any) => t.tag_id),
    archived: row.archived,
  };
}

function mapReminder(row: any): ReminderRow {
  return {
    id: row.id,
    projectId: row.project_id ?? null,
    message: row.message,
    at: row.at,
    repeat: row.repeat,
    recipients: row.recipients ?? [],
    email: row.email,
    fired: row.fired,
    createdBy: row.created_by ?? null,
  };
}

const PROJECT_COLUMNS = 'id,title,due_on,assignee_id,archived,project_tags(tag_id)';

export function createSupabaseReminderRepository(client: SupabaseLike): ReminderRepository {
  return {
    async listPeople(): Promise<Person[]> {
      const rows = await run(client.from('people').select('id,name,email,role,active,prefs').eq('active', true).order('board_order').order('name'));
      return (rows ?? []).map(mapPerson);
    },

    async listDueReminders(now: IsoDateTime): Promise<ReminderRow[]> {
      const rows = await run(
        client.from('reminders').select('id,project_id,message,at,repeat,recipients,email,fired,created_by').eq('fired', false).lte('at', now).order('at'),
      );
      return (rows ?? []).map(mapReminder);
    },

    async claimReminder(id: string, expectedAt: IsoDateTime, next: { fired: true } | { at: IsoDateTime }): Promise<boolean> {
      const patch = (next as { fired?: boolean }).fired ? { fired: true } : { at: (next as { at: IsoDateTime }).at };
      const rows = await run(
        client.from('reminders').update(patch).eq('id', id).eq('fired', false).eq('at', expectedAt).select('id'),
      );
      return Array.isArray(rows) && rows.length === 1;
    },

    async getProject(id: string): Promise<ReminderProject | null> {
      const rows = await run(client.from('projects').select(PROJECT_COLUMNS).eq('id', id));
      return rows && rows.length > 0 ? mapProject(rows[0]) : null;
    },

    async listProjectsWithDue(fromDate: IsoDate): Promise<ReminderProject[]> {
      const rows = await run(client.from('projects').select(PROJECT_COLUMNS).eq('archived', false).gte('due_on', fromDate));
      return (rows ?? []).map(mapProject);
    },

    async listAutoKeys(fromDate: IsoDate): Promise<Set<string>> {
      const rows = await run(
        client.from('reminder_deliveries').select('project_id,auto_kind,due_on').not('auto_kind', 'is', null).gte('due_on', fromDate),
      );
      return new Set((rows ?? []).map((r: any) => `${r.project_id}|${r.auto_kind}|${r.due_on}`));
    },

    async claimAuto(a: AutoReminder): Promise<string | null> {
      const res = await client
        .from('reminder_deliveries')
        .insert({ project_id: a.projectId, auto_kind: a.kind, due_on: a.dueOn, message: a.message })
        .select('id');
      if (res.error) {
        if (res.error.code === '23505') return null;
        throw new Error(res.error.message);
      }
      const rows = res.data;
      return Array.isArray(rows) && rows.length > 0 ? rows[0].id : null;
    },

    async listPushSubscriptions(personIds: string[]): Promise<PushSubscriptionRow[]> {
      if (personIds.length === 0) return [];
      const rows = await run(client.from('push_subscriptions').select('id,person_id,endpoint,p256dh,auth').in('person_id', personIds));
      return (rows ?? []).map((r: any) => ({ id: r.id, personId: r.person_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
    },

    async deletePushSubscription(endpoint: string): Promise<void> {
      await run(client.from('push_subscriptions').delete().eq('endpoint', endpoint));
    },

    async recordDelivery(d: DeliveryRecord): Promise<string> {
      const rows = await run(
        client.from('reminder_deliveries').insert({
          reminder_id: d.reminderId,
          project_id: d.projectId,
          auto_kind: d.autoKind,
          due_on: d.dueOn,
          message: d.message,
          recipient_names: d.recipientNames,
          push_count: d.pushCount,
          email_count: d.emailCount,
          sent_at: d.sentAt,
        }).select('id'),
      );
      return rows[0].id;
    },

    async updateDelivery(id: string, d: { recipientNames: string[]; pushCount: number; emailCount: number }): Promise<void> {
      await run(
        client.from('reminder_deliveries').update({ recipient_names: d.recipientNames, push_count: d.pushCount, email_count: d.emailCount }).eq('id', id),
      );
    },
  };
}
