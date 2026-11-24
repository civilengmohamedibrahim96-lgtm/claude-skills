# Redcon Tender Planning – build plan

Goal: turn the HTML prototype (`index.html`) into a real, shared web app for the **4 planning engineers**, built on the company's **Microsoft 365**, on a setup that costs **$0 a month**.

With 4 users nothing comes close to any free limit, so the setup is kept as small as possible: one database service, one free web host, and the company's own Outlook mailbox and OneDrive / SharePoint.

Free limits checked November 2026 against the providers' pricing pages.

---

## 1. The setup

```
 Microsoft 365 (already paid for)
 ┌───────────────────────────────────────────┐
 │ Outlook – tenders mailbox                 │      every hour: read "ورد الينا", تأجيل, استفسارات
 │ OneDrive / SharePoint – tenders folder    │◄──┐  and send reminder emails
 │ Microsoft sign-in for the 4 users         │   │  (Microsoft Graph)
 └───────────────────────────────────────────┘   │
                                                 │
 Web app (Cloudflare Pages, free) ◄──────► Supabase (free)
 • the board you approved                    • database
 • sign in with Microsoft                    • sign-in check (only the 4 users)
 • upload files straight to SharePoint       • live updates between users
 • installs like an app → notifications      • hourly mail job + 5-minute reminder job
```

| Piece | Service | Cost | Why it is enough for 4 people |
|---|---|---|---|
| Sign-in | **Microsoft account** (your work login) through Supabase | $0 | Only your company's 4 listed users can enter |
| Database, live updates, scheduled jobs | **Supabase** Free | $0 | 500 MB database = many years of tenders |
| Reading the tenders mailbox every hour | Small Supabase function using **Microsoft Graph** | $0 | A few dozen emails a day |
| Reminder emails | Sent **from the tenders mailbox** through Microsoft Graph | $0 | A handful a day; no extra email service |
| Folders and uploads | **SharePoint / OneDrive** tenders folder | $0 (in your M365) | Files stay in your Microsoft storage, not in the database |
| Desktop / browser notifications | Web Push, built into browsers | $0 | No limit |
| Web app hosting | **Cloudflare Pages** | $0 | Updates automatically from GitHub |
| Backups | Weekly copy to a private **GitHub** repository | $0 | The free Supabase plan has no backups of its own |
| Own web address (optional) | e.g. `planning.redcon.com` | ~$10–15 a year, or $0 with `….pages.dev` | – |
| Optional extra | Reminders also posted in a **Teams** chat or channel | $0 | Uses Teams' built-in Workflows |

**Only possible cost:** Supabase Pro at $25 a month, and only if you later want its built-in daily backups. Not needed for 4 people.

**The one free-plan rule to know:** a free Supabase project pauses after 7 days with no activity. The hourly mail check counts as activity, so in normal use it never pauses. If it ever does, restoring is one click and no data is lost.

---

## 2. What I need from you

1. **The tenders mailbox address** – the one that receives the "ورد الينا" emails (a shared mailbox or a person's mailbox).
2. **Where the tenders folder lives** – a SharePoint site's document library (best for a team) or someone's OneDrive – and its link.
3. **The 4 users' names and work emails**, and who is admin.
4. **5–10 real emails** ("ورد الينا", postponements, query answers), personal details blanked out, to tune the email reader.
5. **Who your Microsoft 365 admin is** – they need to do the steps in section 3 once (about 20 minutes).

---

## 3. One-time setup by your Microsoft 365 admin (free)

Done in the Microsoft Entra admin centre and Exchange; I will provide exact click-by-click steps.

1. **Register an app** called "Redcon Tender Planning" (free, no licence needed).
2. **Sign-in for users:** allow the app to sign users in with their work accounts (redirect address: the app's web address).
3. **Permissions, approved by the admin:**
   - read mail and send mail – **limited to the tenders mailbox only** (an Exchange access policy, so the app can never read anyone else's email);
   - read and write files – for the tenders SharePoint site / folder.
4. **Create a client secret** and paste it into Supabase's secret settings (never into the web page). Secrets expire – the admin picks 12 or 24 months, and the app shows a warning a month before expiry.

Until this is done, the board works and projects can be added by hand; email reading and file uploads switch on once it is approved.

---

## 4. What is simplified for 4 users

| In the prototype | In the real app |
|---|---|
| Invite engineers by email, invitation status, resend | **Admin adds the 4 people** by name + work email; they sign in with their Microsoft account. No invitation emails. |
| Choice of Google Drive or OneDrive | **SharePoint / OneDrive only** |
| Separate email-sending service | Reminders sent **from the tenders mailbox** |
| "Preview as engineer", Reset demo | Removed |

Everything else stays as approved: board, columns per engineer in your order, Unassigned, drag to assign, sorting, search bar with filters, cards with submission date and update log, project page and tabs, tender team, reminders.

---

## 5. Data

| Table | Holds |
|---|---|
| `people` | The 4 planning engineers: name, email, admin or not, colour, board order |
| `tender_team` | Tender engineers: name, Arabic first name (for reading emails), public / private |
| `projects` | Title, client, type, tender engineer, supervisor first name, assigned engineer, position, status, received date, **submission date**, SharePoint folder, last update time and by whom |
| `date_changes` | Every submission-date change: old → new, from email or by whom, when |
| `mail_events` | The card's update log; each email's Outlook id so it is never processed twice |
| `tags`, `project_tags`, `subtasks`, `links`, `comments`, `files` | As in the prototype |
| `reminders`, `push_subscriptions` | Reminders and each person's browsers that accept notifications |
| `settings` | Mail keyword, tenders mailbox, main tenders folder, secret expiry date |

Access: only the 4 listed work emails can sign in. Microsoft keys stay on the server side, never in the web page.

---

## 6. Phases

Estimated for one developer, part-time. Usable after phase 1.

**Phase 0 – Collect and set up (1–2 days, mostly waiting for IT)**
Answers to section 2; admin does section 3; create the free Supabase and Cloudflare accounts.

**Phase 1 – The shared board (1–1.5 weeks)**
- Move the prototype into a small project (Vite + plain JavaScript), keeping its design and code.
- Database tables; "Sign in with Microsoft" for the 4 users.
- Board, cards, sorting, search and filters, project page, tags, sub-tasks, links, comments, submission date with history – all on real data, updating live on everyone's screen.
- Team panel: add / order / edit the 4 people; tender team editor.
- Publish on Cloudflare Pages.

**Phase 2 – Hourly email reading from Outlook (1 week)**
- Runs every hour and on the "Sync email" button; reads only new emails in the tenders mailbox.
- Rules tuned on your real emails: "ورد الينا" → new project or update; تأجيل → postponed + new date; استفسارات → queries answers; "والمشرف علي الدراسه :" → supervisor's first name; links → Links tab; every change → the card's update log.
- Each email is processed once and given an Outlook category ("Tender Planning") so you can see what was read; anything it cannot match goes to a "Needs review" list.

**Phase 3 – SharePoint folders and files (3–4 days)**
Create or link a project folder inside the tenders folder; upload from the Uploads tab straight to SharePoint (large drawings included); the Files tab lists the folder's contents with links to open them.

**Phase 4 – Reminders (3–4 days)**
- Checked every 5 minutes: desktop / browser notification, plus an email from the tenders mailbox when chosen (optionally a Teams message).
- Automatic reminders 3 days and 1 day before each submission date.
- "Install app" so notifications arrive when it is closed (works in Edge and Chrome; on iPhone: Add to Home Screen, iOS 16.4+).

**Phase 5 – Launch (2–3 days)**
Import current tenders, weekly GitHub backup, short walkthrough with the 4 users, then two weeks of fixes from real use.

**Total: about 3–4 weeks part-time**, plus however long the IT approval takes.

---

## 7. Risks

| Risk | Handling |
|---|---|
| IT approval takes time | The board is usable with manual entry meanwhile; email and files switch on after approval |
| App secret expires (12–24 months) | Expiry date stored; the app warns the admin a month ahead; renewing takes 5 minutes |
| Free project pauses after 7 idle days | Hourly mail check keeps it active; one-click restore, no data lost |
| No built-in backups on the free plan | Weekly automatic backup to GitHub |
| Email wording changes | Rules in one place, tested on saved sample emails; "Needs review" list |
| iPhone notifications | Need the app on the home screen; email (or Teams) reminders as backup |
