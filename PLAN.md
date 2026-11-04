# SmartTask

## Goal
A personal task capture-and-review app. You type a task in plain language
("call the bank about the overdraft tomorrow !!"), it parses out the due date,
priority, project and tags, assigns a category, and writes it to a Notion
database. Notion is the single source of truth, so you can also edit tasks
in Notion itself. The web app then reads those tasks back and shows them in
smart views (Focus, Today, Upcoming, By Category) rather than one flat list.
Single user, phone-first.

## Stack
- **Next.js 16 (App Router) + React 19 + TypeScript** — one codebase serves the
  UI and the server-side API, so the Notion token never reaches the browser.
- **Plain CSS (CSS variables, no framework)** — zero build risk, full control of
  the mobile layout, and the app is small enough not to need utility classes.
- **Notion API via `@notionhq/client`** — the database. No second datastore to
  host, back up, or keep in sync.
- **In-memory TTL cache (server)** — Notion costs ~500ms per query and rate
  limits around 3 req/s; a 20s cache keeps navigation instant.
- **`node:test` (built-in)** — the pure logic (parser, rules, views, scoring) is
  tested without network or a test framework dependency.
- **Vercel** — free, zero-config for Next.js, env vars for the Notion token.

## Architecture

```
smartask/
  PLAN.md
  README.md                  setup + deploy instructions
  .env.example
  package.json  tsconfig.json  next.config.mjs
  scripts/
    setup-notion.mjs         one-off: creates the Notion DB with the right schema
  src/
    app/
      layout.tsx  globals.css
      page.tsx                 server component: loads tasks, renders the board
      api/tasks/route.ts       GET list / POST create
      api/tasks/[id]/route.ts  PATCH update / DELETE archive
    components/
      QuickAdd.tsx   TaskBoard.tsx   TaskCard.tsx   ViewTabs.tsx
    lib/
      types.ts        Task, NewTask, Category, Priority, ViewId
      parse.ts        plain text -> structured draft (date/priority/project/tags)
      categorize/
        index.ts      Categorizer interface + getCategorizer()
        rules.ts      keyword rules implementation (v1)
      views.ts        focus scoring + grouping into views
      notion.ts       Notion client, page <-> Task mapping, schema constants
      tasks.ts        repository: list / create / update / complete
      cache.ts        TTL cache + invalidation on write
  tests/
    parse.test.ts  rules.test.ts  views.test.ts
```

### Data model (`Task`)
| field | type | notes |
|---|---|---|
| `id` | `string` | Notion page id |
| `title` | `string` | Notion title property `Name` |
| `category` | `Category` | select: Work, Personal, Errands, Health, Finance, Learning, Home, Inbox |
| `priority` | `Priority` | select: Urgent, High, Normal, Low |
| `status` | `Status` | select: Todo, Doing, Done |
| `due` | `string \| null` | ISO date (`YYYY-MM-DD`), Notion date property |
| `project` | `string \| null` | rich text, from `#project` in the input |
| `tags` | `string[]` | multi-select, from `@tag` in the input |
| `note` | `string \| null` | rich text, leftover detail |
| `createdAt` | `string` | ISO datetime, Notion `created_time` |
| `completedAt` | `string \| null` | date |

### Views (`views.ts`)
- **Focus** — top 5 by score: `priorityWeight*10 + urgency(due) + ageDays*0.5`
- **Today** — overdue + due today, priority-sorted
- **Upcoming** — due in the next 7 days, grouped by day
- **Categories** — everything open, grouped by category
- **Done** — completed in the last 14 days

## Decisions & constraints
Later phases must not violate these:
1. **The Notion token is server-side only.** It is read from `process.env` inside
   `src/lib/notion.ts`; no client component may import that module.
2. **Notion is the source of truth.** No local database, no local task JSON. The
   cache is a read optimisation only and is cleared on every write.
3. **Categorization goes through the `Categorizer` interface** in
   `src/lib/categorize/index.ts`. Swapping rules for Claude must mean adding one
   file and changing `getCategorizer()` — nothing else.
4. **`parse.ts`, `views.ts`, `categorize/rules.ts` stay pure** — no I/O, no
   `Date.now()` at call sites (a `now` argument is passed in) — so they are testable.
5. **The app degrades without Notion configured**: if the env vars are missing,
   the UI shows a setup screen instead of crashing.
6. **No framework CSS.** Styling is `globals.css` + CSS variables, light/dark.
7. **Out of v1 scope:** recurring tasks, notifications, multi-user, Notion->app
   webhooks, offline mode.

## Phases
- [x] Phase 1: Scaffold & Notion schema — Next.js project boots, `npm run setup:notion` creates the database in Notion, `.env.example` documented — Done when: `npm run dev` serves a page and the setup script prints a database id that is visible in Notion.
- [x] Phase 2: Parser & categorizer — `parse.ts`, `categorize/rules.ts`, `types.ts` + tests — Done when: `npm test` passes and `"pay rent friday !! #home @bills"` parses to due=next Friday, priority=Urgent, project=home, tags=[bills], category=Finance.
- [x] Phase 3: Notion data layer — `notion.ts`, `notion-mapping.ts`, `tasks.ts`, `cache.ts` — Done when: a script can create a task and list it back from the real Notion database. **Code complete and unit-tested; the live round-trip needs your integration token — see Status log.**
- [x] Phase 4: API routes — `api/tasks` GET/POST, `api/tasks/[id]` PATCH/DELETE — Done when: `curl -X POST /api/tasks -d '{"text":"buy milk tomorrow"}'` returns the created task and it appears in Notion. **Routes built and every error path exercised with curl; the Notion write itself is unverified — see Status log.**
- [x] Phase 5: Views engine — `views.ts` + tests — Done when: `npm test` passes, including focus-score ordering and overdue handling.
- [x] Phase 6: UI — layout, QuickAdd, ViewTabs, TaskBoard, TaskCard, globals.css — Done when: on a phone-width screen you can add a task, see it land in the right view, and tick it done.
- [x] Phase 7: Docs & deploy — README with Notion + Vercel setup — Done when: a stranger can follow README.md from zero to a deployed app.
- [ ] Phase 8 (deferred): Claude categorizer — `categorize/claude.ts` behind `ANTHROPIC_API_KEY` — Done when: with a key set, free-text tasks get categories the rules miss, and with no key the app still works.

## Status log

**2026-11-04 — Phases 1-7 complete (v1 shipped).**
All seven v1 phases built and verified in one session. 46 unit tests pass,
`tsc --noEmit` is clean, `next build` succeeds, and the UI was checked in a real
browser at phone and desktop widths in both colour schemes, with no console errors.

Changes to the plan made while building, and why:

- **`notion.ts` was split into `notion.ts` + `notion-mapping.ts`.** The Notion
  SDK is CommonJS, so Node's test runner cannot named-import it. The pure page
  <-> Task mapping now lives in its own module and is directly tested; only the
  client wiring needs the SDK.
- **`capture.ts` was extracted from `tasks.ts`** for the same reason: the
  parse-then-categorize pipeline is pure and worth testing without a network.
- **Category naming is two-tier, not a single override.** The original rule let
  any `#project` naming a category force it, which made
  "pay the electricity bill #home" a *Home* task. Now a `@tag` that names a
  category wins outright, and a `#project` only applies when no keyword matched.
- **Relative imports carry explicit `.ts`/`.tsx` extensions,** so `node --test`
  runs the source with no build step. Verified against `next build`.

Known issues / deliberate gaps:

- Notion edits do not reach an already-open tab; the ↻ button re-reads.
- The 20s read cache lives in module scope, so a serverless platform with
  several warm instances can briefly serve different snapshots. Harmless for
  one user; a shared cache would be the fix if it ever matters.
- Phase 8 (Claude categorizer) is deliberately not built — the seam is in place
  and unused.
- The capture pipeline has not been run against a live Notion workspace; that
  needs the user's own integration token. Every error path (missing config, bad
  JSON, invalid enum) was exercised against the running server.
