# Redcon Tender Planning – build plan

Goal: turn the HTML prototype (`index.html`) into a real, shared web app for the planning team, on a setup that costs **$0 a month** for a team of this size.

Figures checked November 2026 against the providers' pricing pages.

---

## 1. The setup in one picture

```
 Mailbox (Gmail or Outlook)                     Google Drive or OneDrive
        │ hourly: read "ورد الينا", تأجيل, استفسارات      ▲ project folders + uploads
        ▼                                               │
 Mail reader ──────────────► Supabase (free) ◄───────── Web app (static, free hosting)
 (Apps Script or             • Postgres database          • the board you approved
  Edge Function)             • logins + invitations       • opens in any browser,
                             • live updates between users   installs like an app (PWA)
                             • scheduled jobs (reminders)
                                    │
                                    ├── desktop / browser notifications (Web Push, free)
                                    └── reminder & invitation emails (Resend, free)
```

| Piece | Service | Cost | Free limit that matters |
|---|---|---|---|
| Database, logins, live updates, scheduled jobs | **Supabase** Free | $0 | 500 MB database (years of tender data), 50,000 users; pauses after 7 idle days (the hourly mail sync keeps it awake) |
| Web app hosting | **Cloudflare Pages** | $0 | Unlimited visits; deploys automatically from GitHub |
| Reading the mailbox every hour | **Google Apps Script** (Gmail) or a **Supabase Edge Function** (Outlook) | $0 | Well inside quotas at a few dozen emails a day |
| Project folders and file uploads | **Google Drive** or **OneDrive** (your existing accounts) | $0 | Files never touch Supabase, so the 1 GB storage limit is not used |
| Desktop / browser notifications | **Web Push** (built into browsers) | $0 | No limit |
| Reminder and invitation emails | **Resend** Free | $0 | 100 emails a day, 3,000 a month |
| Code and backups | **GitHub** (this repository) | $0 | Weekly database backup to a private repository |
| Own web address (optional) | e.g. `planning.redcon.com` | ~$10–15 a year, or $0 using `*.pages.dev` | – |

**When you would pay:** only if the team outgrows the free limits or you want Supabase's daily backups and no pausing – Supabase Pro is $25 a month. Nothing else in this plan needs a paid tier.

---

## 2. The one decision needed before starting

**Which email and file system does the company use?** The mail reader and the drive connection are built for one of them first.

| | **A. Google (Gmail / Google Workspace + Google Drive)** – simplest | **B. Microsoft (Outlook / Microsoft 365 + OneDrive / SharePoint)** |
|---|---|---|
| Reading mail hourly | Apps Script inside the tenders mailbox, hourly trigger, no server | Supabase Edge Function on an hourly schedule, calling Microsoft Graph |
| Setup needed from IT | None beyond the mailbox owner approving the script once | Register a free "app" in Microsoft Entra (Azure) and an admin approves mail + files access |
| Folders and uploads | Drive API with each user's Google sign-in | Graph API with each user's Microsoft sign-in |
| Sign-in to the app | "Sign in with Google" or email link | "Sign in with Microsoft" or email link |

Both are free. Option A has fewer moving parts. The choice between Google Drive and OneDrive stays in the app's settings, as in the prototype, but only the chosen one is built in phase 4; the other can be added later.

Also needed: **5–10 real "ورد الينا", postponement and query-answer emails** (personal details can be blanked out). The email parser is tuned on these.

---

## 3. Data (what the database stores)

| Table | Holds |
|---|---|
| `profiles` | Planning engineers: name, email (optional), role (admin / engineer), colour, **board order**, has a column |
| `tender_team` | Tender engineers: name, Arabic first name (for reading emails), public / private |
| `projects` | Title, client, type, tender engineer, supervisor first name (from email), assigned planning engineer, position, status text, received date, **submission date**, folder link, source, last update time and by whom |
| `date_changes` | Every submission-date change: old → new, from email or by whom, when |
| `mail_events` | The card's email-update log: type (new / update / postponed / queries answers), summary, subject, links found, the email's unique id (so no email is processed twice) |
| `tags`, `project_tags` | Tags, many per project |
| `subtasks` | Text, done, notes, date, order |
| `links`, `comments`, `files` | Links tab, comments (including the automatic history), files saved to Drive / OneDrive |
| `reminders` | Message, project (optional), time, repeat, who gets it, by email or not, sent |
| `push_subscriptions` | Each person's browsers that accepted desktop notifications |
| `settings` | Mail subject keyword, drive provider, main tenders folder, sync interval |

Access rules (Supabase row-level security): every signed-in team member can see and edit projects; only admins manage the team, the tender team and settings. Secret keys stay on the server side, never in the web page.

---

## 4. Phases

Each phase ends with something the team can use. Estimated for one developer working part-time.

### Phase 0 – Decide and collect (1–2 days)
- Choose option A or B (section 2).
- Collect the sample emails.
- Create the free accounts: Supabase, Cloudflare, Resend; confirm access to the tenders mailbox and the main tenders folder.

### Phase 1 – The board, shared and live (1–2 weeks)
- Move the prototype into a small project (Vite, plain JavaScript – no framework to learn), reusing its design and code.
- Create the database tables and access rules.
- Sign-in by email link (plus Google or Microsoft sign-in).
- Board with real data: columns per planning engineer in the chosen order, Unassigned, drag to assign, sorting per column, search bar with filters, cards with submission date, tags, status, update log button.
- Project page: details, submission date with history, tender team, tags, sub-tasks, links, comments.
- Live updates: a change by one person appears on everyone's screen within a second.
- Publish on Cloudflare Pages.
- **Result:** the team stops using the prototype and works on the real board.

### Phase 2 – Team and admin (3–4 days)
- Team panel: add planning engineers (name only, or with email to invite), reorder, edit profiles, remove.
- Invitation emails through Resend; invited people set up their profile on first sign-in.
- Tender team editor (names, Arabic names, public / private).

### Phase 3 – Hourly email reading (1 week)
- The mail reader runs every hour and also on the "Sync email" button.
- Rules from the prototype, tuned on the real emails:
  - "ورد الينا" → new project in Unassigned, or "New updates" if the project already exists (matched by project name)
  - تأجيل → Postponed, new submission date
  - استفسارات → Queries answers
  - "والمشرف علي الدراسه :" → supervisor's first name; unknown names join the tender team automatically
  - every link in the body → Links tab; every change → the card's update log and date history
- Each email is processed once (its unique id is stored); processed emails get a label / category in the mailbox.
- Emails the reader cannot match go to a **"Needs review"** list instead of being lost.

### Phase 4 – Folders and files (1 week)
- Create a project folder inside the main tenders folder, or link an existing one.
- Upload files from the Uploads tab straight to that folder; the Files tab lists what is in it.
- Each person signs in to Google or Microsoft once to allow this.

### Phase 5 – Reminders and notifications (1 week)
- A scheduled job every 5 minutes sends due reminders: desktop / browser notification (Web Push) and, when chosen, an email.
- Reminders for everyone, the assigned engineer, or chosen people; repeat hourly, daily or weekly.
- Automatic reminders: submission date in 3 days and tomorrow; new project in Unassigned for more than a day.
- Optional daily summary email at 08:00.
- The app can be installed from the browser ("Install app") so notifications arrive even when it is closed. On iPhone this needs "Add to Home Screen" (iOS 16.4 or later).

### Phase 6 – Launch and care (3–4 days)
- Import the current live tenders.
- Weekly automatic database backup to a private GitHub repository (GitHub Actions, free) – the free Supabase plan has no backups of its own.
- A short "how to use" page; a 30-minute walkthrough with the team.
- Two weeks of fixes from real use.

**Total: about 5–7 weeks part-time**, usable after phase 1.

---

## 5. Risks and how they are handled

| Risk | Handling |
|---|---|
| Supabase free project pauses after 7 days with no activity | The hourly mail sync is activity, so it stays awake; if it ever pauses, restoring is one click and no data is lost; Pro ($25/month) removes pausing |
| No automatic backups on the free plan | Weekly backup via GitHub Actions (phase 6) |
| Email wording changes over time | Parser rules kept in one place and tested against saved sample emails; unmatched emails go to "Needs review" |
| Microsoft option needs IT approval | Ask IT in phase 0; until approved, the board works and projects can be added by hand |
| iPhone notifications | Need the app added to the home screen; email reminders cover anyone who does not |
| Email sending limit (100 a day) | Plenty for a small team; reminders are grouped into one email per person when several are due together |

---

## 6. What carries over from the prototype

Everything already agreed in the prototype is the specification: layout, colours, REDCON logo, card design, submission-date row, update-log drop-down, sorting, search bar with filters, project page and tabs, team panel, reminders panel, email rules. The prototype's code is reused as the starting point for the real app, so the look does not change – the data simply becomes shared and real.
