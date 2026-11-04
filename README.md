# SmartTask

Capture a task in plain language, let it file itself, keep everything in Notion.

You type `pay the electricity bill friday !! #home @bills` and SmartTask pulls
out the due date, the priority, the project and the tags, works out that it is a
**Finance** task, and writes it to a Notion database. The web app then reads
those tasks back and shows them in views worth looking at — what to do *now*,
what is due today, what is coming — instead of one flat list.

Notion is the database. There is no second store to host or back up, and you can
edit any task in Notion itself and see the change in the app.

## What the capture box understands

| You type | It sets |
|---|---|
| `tomorrow`, `friday`, `next monday`, `in 3 days`, `next week` | Due date |
| `25/12`, `2026-12-25`, `dec 25`, `25 dec` | Due date (a date already past rolls to next year) |
| `!` / `!!` | High / Urgent priority |
| `urgent`, `asap` / `important` / `someday` | Urgent / High / Low priority |
| `#project` | Project |
| `@tag` | Tag |
| anything after a newline or ` // ` | Note |

Whatever is left becomes the title, with the matched phrases removed — so
`call the bank about the overdraft tomorrow` is titled *call the bank about the
overdraft* and due tomorrow.

The category is worked out from the words in the task. Two rules decide it:

- A **tag** that names a category wins outright — `@work` is a deliberate statement.
- A **project** that names a category is only a fallback, used when nothing else
  matched. `#home` on "pay the electricity bill" means the household project,
  so the task is still Finance.

Everything is editable in Notion afterwards; it is a normal database.

## The views

| View | Shows |
|---|---|
| **Focus** | The five tasks most worth doing, scored on priority, urgency and age. An overdue Low task outranks a Normal task due next week. |
| **Today** | Overdue first, then due today. Nothing else. |
| **Upcoming** | The next seven days, grouped by day, with undated tasks at the bottom. |
| **All** | Every open task grouped by category. |
| **Done** | Completed in the last 14 days. |

## Setup

You need a free Notion account. Takes about five minutes.

### 1. Create a Notion integration

Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) →
**New integration** → give it a name (e.g. *SmartTask*) and pick your workspace.
Copy the **Internal Integration Secret** — it starts with `ntn_`.

### 2. Pick a parent page and connect the integration

In Notion, open (or create) the page the task database should live inside.
Click **•••** at the top right → **Connections** → **Connect to** → your
integration. Without this step Notion will say it cannot find the page.

Then **Copy link** on that page — you will paste the whole URL in a moment.

### 3. Configure

```bash
git clone <your fork> smartask && cd smartask
npm install
cp .env.example .env.local
```

Edit `.env.local`:

```
NOTION_TOKEN=ntn_…                        # from step 1
NOTION_PARENT_PAGE_ID=https://notion.so/… # the page link from step 2
```

### 4. Create the database

```bash
npm run setup:notion
```

It creates a **SmartTask** database with the right schema and prints its id.
Put that id in `.env.local`:

```
NOTION_DATABASE_ID=…
```

### 5. Verify the connection

```bash
npm run check:notion
```

This is read-only — it changes nothing in your workspace. It walks the chain one
link at a time (token → database → schema → an actual read) and tells you which
link is broken and how to fix it, instead of leaving you to guess from a 500.

### 6. Run

```bash
npm run dev          # http://localhost:3000
```

If the env vars are missing the app shows a setup screen rather than crashing,
so you can always tell what is not configured yet.

## Deploying to Vercel

1. Push this repo to GitHub.
2. [vercel.com/new](https://vercel.com/new) → import the repo. Next.js is
   detected, no build settings to change.
3. Add `NOTION_TOKEN` and `NOTION_DATABASE_ID` under
   **Settings → Environment Variables** (`NOTION_PARENT_PAGE_ID` is only needed
   for the setup script, not at runtime).
4. Deploy, then add the URL to your phone's home screen.

The token is only ever read on the server, so it never reaches the browser.

## Development

```bash
npm run dev           # dev server
npm test              # 46 unit tests, no network needed
npm run lint          # tsc --noEmit
npm run build         # production build
npm run check:notion  # diagnose the Notion connection (read-only)
npm run setup:notion  # create the tasks database (run once)
```

### How it fits together

```
src/
  app/
    page.tsx                 server component: reads Notion, renders the board
    api/tasks/route.ts       GET list / POST capture
    api/tasks/[id]/route.ts  PATCH update / DELETE (to Notion trash)
  components/                client components: QuickAdd, ViewTabs, TaskBoard, TaskCard
  lib/
    parse.ts                 text -> structured draft      (pure, tested)
    categorize/              Categorizer interface + keyword rules (pure, tested)
    capture.ts               parse + categorize pipeline    (pure, tested)
    views.ts                 focus scoring and grouping     (pure, tested)
    notion-mapping.ts        Notion page <-> Task           (pure, tested)
    notion.ts                SDK client, config, data source
    tasks.ts                 repository: list / create / update / archive
    cache.ts                 20s read cache, cleared on every write
```

The pure modules take `now` as an argument rather than reading the clock, which
is why they are testable without mocks — and why "tomorrow" means *your*
tomorrow: the browser sends its own timestamp when you capture a task.

### Swapping keyword rules for Claude

`src/lib/categorize/index.ts` defines a `Categorizer` interface. Adding a
Claude-backed implementation means writing one file and returning it from
`getCategorizer()` when `ANTHROPIC_API_KEY` is set. Nothing else imports the
rules directly. See Phase 8 in `PLAN.md`.

## Troubleshooting

Run `npm run check:notion` first — it names the broken link. The failures worth
knowing about:

| What you see | What it means |
|---|---|
| `Notion rejected the token` | `NOTION_TOKEN` is wrong or was regenerated. Copy the Internal Integration Secret again, in full. |
| `Notion cannot find that page or database` | Almost always the missing **Connections** step, not a wrong id. Notion reports anything an integration was never given access to as *not found*, never as *forbidden* — so "not found" usually means "not shared". |
| `Could not reach api.notion.com` | A network problem, not an auth one: VPN, proxy, firewall, or a sandbox with a host allowlist. |
| `Missing property "…"` | The database schema drifted from what the app expects — usually a property renamed by hand in Notion. Rename it back, or create a fresh database with `npm run setup:notion`. |
| `Notion is rate limiting` | Roughly 3 requests/second. Wait and retry. |

A thing worth internalising: **the token says *who* the app is, and the
Connections step says *what it may see*.** They are separate, and a valid token
with no page access looks exactly like a wrong id.

## Notes and limits

- **Notion rate limits** at roughly 3 requests/second. Fine for one person; the
  app caches reads for 20 seconds and clears that cache on every write.
- **Deleting** moves the Notion page to the trash. Nothing is destroyed, and you
  can restore it from Notion.
- **Not in v1:** recurring tasks, reminders, multiple users, and pushing Notion
  edits back to an open tab (hit ↻ to re-read).
