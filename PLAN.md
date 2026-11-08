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
> **Revised 2026-11-05 (see Status log):** the app is now a *static* site hosted
> on GitHub Pages. There is no server. The Notion token is entered once and kept
> in the browser's local storage, and the browser calls the Notion API directly
> (the Notion API sends CORS headers, so this works).

- **Next.js 16 (App Router) + React 19 + TypeScript**, built with
  `output: 'export'` to plain HTML/CSS/JS — no server to run or pay for.
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
      manifest.ts              installable-on-phone metadata
    components/
      QuickAdd.tsx   TaskBoard.tsx   TaskCard.tsx   ViewTabs.tsx
    lib/
      types.ts        Task, NewTask, Category, Priority, ViewId
      parse.ts        plain text -> structured draft (date/priority/project/tags)
      categorize/
        index.ts      Categorizer interface + getCategorizer()
        rules.ts      keyword rules implementation (v1)
      views.ts        focus scoring + grouping into views
      config.ts       token + database id in localStorage
      notion.ts       browser Notion client (dangerouslyAllowBrowser)
      tasks.ts        repository factory over a config
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
1. ~~**The Notion token is server-side only.**~~ **Superseded 2026-11-05.** The
   token lives in the browser's local storage on the user's own device. It is
   never committed, never in the built bundle, and never sent anywhere but
   `api.notion.com`. The connect screen must say plainly where it is stored.
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
6b. **Nothing may require a server.** No API routes, no server-side data
   fetching, no dynamic functions — `next build` must produce a clean static
   export or the deploy breaks.
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
- [x] Phase 9: Static data layer — `config.ts`, browser `notion.ts`, `tasks.ts` repository factory; API routes and `http.ts` deleted — Done when: `npm test` passes and nothing under `src/` reads `process.env` for Notion.
- [x] Phase 10: Connect screen & client-side board — `App.tsx`, `ConnectForm.tsx`, `TaskBoard` loads through the repository — Done when: with no token the app shows a connect form, and saving one renders the board.
- [x] Phase 11: Static build & GitHub Pages deploy — `output: 'export'`, basePath, `.github/workflows/deploy.yml` — Done when: `next build` emits `out/` and pushing to `main` publishes the site.
- [x] Phase 12: Dates in any language — Gemini returns a due date and a date-free title; the local parser's date always wins, the AI's only fills the gap — Done when: "לשלם חשבון חשמל מחר" saves as Finance, due tomorrow, titled "לשלם חשבון חשמל".
- [x] Phase 13: Voice input — browser speech recognition, Hebrew or English, transcript into the capture box for review — Done when: speaking a task fills the box and Add saves it; where the browser cannot, the user is pointed at the keyboard's dictation key.
- [x] Phase 14: Phone-only mode — tasks kept in the browser with no account; Notion becomes optional; backup and restore — Done when: a new user can choose "On this phone only" and use every feature with zero Notion requests, and a user with saved Notion credentials sees no change.
- [x] Phase 15: Editable and custom categories — tap a task's category to move it, or create a new category — Done when: a new category is applied, survives a reload in both stores, gets its own group in All, and Gemini can file into it.
- [x] Phase 8: AI categorizer — `categorize/gemini.ts` behind a user-supplied Google AI Studio key — Done when: with a key set, free-text tasks get categories the rules miss, and with no key the app still works. **Built with Gemini rather than Claude at the user's request; the `Categorizer` seam took it unchanged.**

## Status log

**2026-11-08 — Bug-hunt chunk 2: board timing and saving.**

Most of these came from one cause: the board kept a single copy of the list,
and any read or failed save overwrote it wholesale. Now every write is
remembered (`board-sync.ts`): pending ones until they finish, finished ones for
25 s, and each read is merged with them instead of replacing the list.

- A read in flight no longer undoes a newer add, tick or delete (R1-5); the
  cache no longer stores a read that a write overtook (`cache.ts` epoch).
- A failed save reverts only its own task (R1-6); an older answer arriving
  after a newer save to the same task is ignored (R3-6).
- Sort with Gemini re-checks each task against the live list and skips one you
  moved, completed or deleted meanwhile (R1-7); it is cancelled when the board
  closes (⏻) or the AI settings or store change (R1-26, R3-4); its result stays
  visible until dismissed or the next capture (R1-52).
- A ticked task stays in place, struck through, for 2 s — a second tap reopens
  it instead of completing the next card (R1-16).
- The capture box keeps text typed while saving (R1-8), is read-only while the
  mic listens (R1-28), and keeps the text of a task being saved on the device
  until it is confirmed, restoring it if the app closed mid-save (R3-1).
- Gemini requests time out after 15 s and fall back to the rules with a note
  (R1-12).
- AI settings cover the board instead of replacing it, so drafts and the view
  survive (R1-26).
- Load and save errors are separate: a load error stays until a read succeeds
  and a successful save re-reads an unloaded list (R1-50); a save error names
  the task and offers dismiss, not a "retry" that only re-read (R1-51).
- Phone-only mode re-reads on return and when another open copy changes the
  tasks (R1-15); the category sheet works on the live task by id (R3-5).
- Review (two adversarial reviewers, ~20 scripted scenarios in the built app)
  found 15 issues, fixed: saves to one task are now queued (`Ledger`), so
  answers arrive in order and a failure reverts to the last confirmed state
  plus queued changes and is always reported; a failed save no longer forgets
  the task's earlier write; the merge window is 0 for device storage and 5 s
  for Notion (was 25 s, which hid changes made elsewhere); reads are numbered
  so an older one never replaces a newer one; the board is reset only for a
  new store or a restored backup, not an AI-settings change; reopening in the
  Done view settles too; settled cards move only after 2 s without a tap, and
  a ✓/✕ tap within 400 ms of that shift is ignored; ✓ is never disabled, so the
  undo tap works while saving; the box is read-only while saving (so a failed
  save leaves the text right there) and a draft restored in one copy clears
  when another copy finishes saving it; the Gemini timeout text is neutral.
  Accepted: a change made in Notion within 5 s of the app's own save to that
  task can be masked until the next refresh.

**2026-11-08 — Bug-hunt chunk 1 fixed; Gemini can create categories.**

From `docs/bug-hunt-2026-11-06.md`, the parser, date and Notion-id group:

- Parser (`parse.ts`): matching now blanks claimed text with spaces of the same
  length, so a token before a date no longer cuts the wrong letters (R1-1) and
  overlapping spans are merged (R1-10). Links are masked before matching and
  word edges are stricter (R1-19). Date patterns try every match and only real
  month names (R1-9); a year after a month name is honoured (R1-20); impossible
  dates are rejected, 29/02 waits for a leap year (R1-21); months are added with
  the day clamped (R1-22). A bare day.month with no year ranks below
  today/tomorrow but above weekdays ("dentist monday 16/11" is the 16th), and is
  refused when it looks like a quantity (unit after it), a time or price, a
  version (dotted, after an English word), or 24/7 (R1-4) — a missed date keeps
  its text and Gemini can fill it. Priority words are case-insensitive (R1-18), ambiguous ones count
  only at the start or end, "not urgent" is Low (R1-17), `now!` and `!!!!` work
  (R1-45), and `@urgent`/`#asap` set priority. A preposition is removed only
  with the date it introduces, in English and Hebrew (R1-44, R2-2). Hebrew
  acronyms with a plain quote stay whole in tags (R2-10).
- Dates: Notion timestamps and restored ones become the local day
  (`localDateOf`, R1-2); Completed and the backup file name use the local day
  (R1-34, R2-16).
- Notion ids: the last id in the link path that touches no other hex
  character, in the app and the scripts (R1-3, R2-5).
- Feature: `classifyWithGemini` lists every category, asks for the best
  existing fit, and only then a new short general one (`created: true`);
  `acceptNewCategory` rejects bad names and maps plural/case twins to the
  existing category. App remembers created names at once so quick captures
  and Sort with Gemini reuse them.
- Review: three adversarial reviewers (parser differential on 409 inputs plus a
  50k-input fuzzer; dates and ids; the feature in the built app with Playwright)
  found 19 issues, all fixed with tests: links cut out after "on/at", a weekday
  beating an explicit date, amounts read as years, Hebrew dates before
  "שעה"/nouns refused, punctuation glued, more negations, emoji edges, noun
  phrases ("urgent care"), more units and Hebrew lead-ins, hand-written
  timestamps in backups, removed categories coming back, -ies plurals, Hebrew
  names of built-ins, and a category fished out of Gemini's reason text.
  Fragmented titles in the fuzzer: 20,416 before chunk 1, 18 after.

**2026-11-06 — Phase 15: editable and custom categories.**

Tapping a task's category opens a sheet listing every category, the current
one marked, with a field to create a new one.

Categories were a closed set of eight, and that assumption was load-bearing in
places a new name would have silently fallen through: Notion and local reads
coerced any unknown name to Inbox, the All view only grouped the eight, colours
only existed for the eight, and Gemini only accepted the eight. `Category` is
now any name passing `normalizeCategoryName` — trimmed, no commas (Notion select
options cannot hold them), at most 40 characters, and a built-in in other
casing resolves to the built-in so "work" never becomes a second Work.

Making the type a plain string meant the compiler could no longer catch these
spots; the tests did. Three failed on the change. One was a real regression —
Gemini accepting an invented category — fixed by validating its answer against
the user's own list. The other two encoded the old Inbox fallback and were
updated to the new rule.

- **The list** is the built-ins, then the user's own A-Z, Inbox last. Custom
  names are saved per device *and* learned from tasks, so one created on another
  phone, or added straight in Notion, appears without setup.
- **Colour**: a custom category's hue is hashed from its name, so it is the
  same everywhere without anyone choosing it.
- **Gemini** is offered custom categories by name, read at call time, so one
  created a moment ago is already a candidate.
- **Removal**: an unused custom category can be removed from the list.
  Built-ins never can.
- The category chip is now shown in every view, including All — it is a
  control now, not just a label.

Not verified: that Notion creates a select option on first write of a new
name. Notion's documented behaviour, and what @tags already rely on, but
`api.notion.com` is unreachable from here. A refusal would show Notion's
message in the banner.

**2026-11-06 — Voice: review before adding, at the user's request.**

Auto-adding on end of speech was reverted to a review step: speech fills the
box, the user checks or corrects it, and taps Add. Everything else from the
previous change stays — `voice-session.ts` still ends the session when speech
stops, guarantees the complete final transcript, and lets nothing late through.

The one new rule is what keeps the old race closed: **Add is disabled while
listening**, and a keyboard Enter is ignored then too. Interim words are on
screen while you speak, and an early tap is exactly what used to save a cut-off
task and then refill the box. Add becomes available the moment the mic stops,
and what is in the box at that point is what is saved. A reminder under the box
asks the user to check the text; it disappears once they edit it.

**2026-11-06 — Voice is hands-free; fixes a voice race that cut tasks short.**

Requested: add the task when the user stops talking, and leave the box empty
for the next one. Reproducing it first turned up a real bug. Android delivers
its final recognition result a beat after speech ends. Tapping Add in that gap
saved the *interim* text — "לשלם חשבון" instead of "לשלם חשבון חשמל" — cleared
the box, and then the late final result wrote the full text back into it.

`voice-session.ts` now owns a session's timing, framework-free and unit-tested
with a hand-driven recognizer and clock:

- **Speech ending adds the task**, with the complete final transcript, exactly
  once. Whichever comes first ends it: the recognizer's own end-of-speech,
  tapping the mic again, or a 2-second silence backstop for when Android keeps
  listening after the user stops. The backstop restarts on every word, so a
  pause mid-sentence is not cut off, and it never starts before any speech.
- **A closed session lets nothing through.** Late results are ignored, so the
  cleared box stays clear. Tapping Add mid-speech cancels the session for the
  same reason.
- **A failure part-way never auto-adds.** Whatever was heard stays in the box
  to fix and add by hand.

Verified in the built app with an Android-timed fake microphone across six
scenarios, including the exact race above.

**2026-11-06 — Phase 14: phone-only mode; Notion becomes optional.**

The user asked that new users not need a Notion account, without changing
their own Notion setup.

`local-store.ts` implements the same `TaskRepository` interface as the Notion
store, so the board, capture, Gemini sorting, Hebrew dates and voice run on
either unchanged. Tasks live in `localStorage` under their own key.

**Existing users are protected by precedence, not by a migration.**
`resolveStorageMode` checks saved Notion credentials first, so anyone already
connected goes straight to their board as before; a leftover phone-only flag
cannot override them. The end-to-end run checks this explicitly: no choice
screen, Notion queried, refresh and open-in-Notion links still present.

A first launch with nothing saved now asks where tasks should live. Phone-only
mode makes zero Notion requests, hides the Notion refresh and links, and words
deletion as permanent — there is no trash to recover from.

The cost of phone-only is that the tasks exist in one browser on one device.
Two mitigations:

- `navigator.storage.persist()` is requested on entering phone-only mode,
  asking the browser not to evict the data. Android grants this readily for an
  installed app; a refusal is silent and just makes backups matter more.
- **Back up / Restore** sits under the board: a JSON file, restored by merging
  on task id, so restoring twice adds nothing and an old backup never deletes
  newer tasks.

Switching stores never deletes anything. Leaving phone-only returns to the
choice screen, which shows how many tasks are waiting on the device.

Not built: moving phone-only tasks into Notion when someone connects later.
They stay on the device and reappear if phone-only is chosen again, but they
are not uploaded.

**2026-11-06 — Phases 12-13: Hebrew dates through Gemini, and voice input.**

*Dates.* The same Gemini call that picks the category now returns `due` and a
`title` with the date words removed. Two rules keep it honest:

- **The local parser wins.** A date it found ("friday") is deterministic and
  tested; an AI date only fills the gap when the parser found none — which in
  practice means Hebrew.
- **`sanitizeExtraction` checks everything.** The date must be real
  (`2026-02-31` is refused) and plausible (a week overdue to three years
  ahead). The title may only *remove* words — every word must already be in the
  original — so a model that translates or rephrases is ignored and the user's
  own words are kept.

The prompt carries today's date and the next fourteen days written out with
weekday names, because models are unreliable at weekday arithmetic and
"ביום שלישי" cannot be answered without looking the date up.

*Voice.* The browser's own speech recognition, not Gemini audio: free, no key,
works with AI off, and words appear as you speak. Hebrew by default on a device
that lists Hebrew, with a one-tap language toggle that persists. The transcript
goes into the box for review; nothing saves until Add. Support is uneven —
solid on Android Chrome, present in Safari, and known to fail in iPhone apps
added to the home screen — so every failure names the cause and points at the
keyboard's own dictation key, which works everywhere.

Verified end to end with a simulated microphone and intercepted Gemini: words
stream in while speaking, recognition runs in `he-IL`, the mic stops after a
pause, and a refused recognizer explains itself. **Not verified on a real
phone or microphone**, and the real Gemini's date judgements are untested —
the intercepted one answered from the calendar in the prompt.

**2026-11-06 — Fix: every task landing in Inbox.**

Reported by the user after connecting Notion and Gemini. Diagnosed by reading
the live Notion database: both captured tasks were **Hebrew** and both were
`Inbox`. Five compounding causes, all fixed:

1. **The keyword rules are English-only**, so every Hebrew task scored zero.
   Left as is — Gemini is the real answer — but the UI now says so instead of
   silently filing to Inbox.
2. **The Gemini prompt never mentioned other languages and explicitly
   sanctioned Inbox for "vague" tasks.** Short tasks are the normal case, so it
   was invited to give up. The prompt now says tasks may be Hebrew, includes
   Hebrew worked examples, describes academic work under Work, and makes Inbox a
   stated last resort.
3. **The Gemini-failure notice rendered below the whole task list**, invisible
   on a phone. Removed; failures now show directly under the capture box.
4. **The live preview always showed the English-only rules guess** — "Inbox"
   for every Hebrew task even with Gemini on. With AI on it now says Gemini will
   decide.
5. **Nothing said who filed a task.** `CategorySignal` now carries `source` and
   `fallbackReason`, and a line under the capture box says whether Gemini or the
   rules decided, and why if Gemini failed.

Added **Sort with Gemini** for tasks already stuck in Inbox (`recategorize.ts`):
sequential with a gap for the free tier, stops on the first error with its
reason rather than hammering a refusing API, and never overwrites a task with a
fallback answer. Card titles, notes and the input use `dir="auto"` so Hebrew
reads right-to-left.

Verified end to end in the built app with Notion and Gemini intercepted at the
network layer: a Hebrew capture reaches Gemini intact, the key travels in a
header and not the URL, Notion receives Gemini's category, the two real Inbox
tasks re-sort, and a 429 still saves the task and explains itself near the top
of the screen. **Not verified: what the real Gemini decides** — the intercepted
Gemini answered with categories I chose. The plumbing is proven; the judgement
is not.

Also added **refresh on return**: the app re-reads Notion when it becomes
visible or focused again, so an edit made in Notion is on screen by the time
you switch back. Throttled to once per 10 seconds — phones fire visibility and
focus together, and the end-to-end run confirms that burst produces exactly
one read — and skipped while a capture or sort is in flight. Not a timer:
nothing is fetched while the app sits unused.

Known gap, not addressed: the date parser is English-only, so "מחר" (tomorrow)
is not recognised and Hebrew tasks get no due date.

**2026-11-05 — Phase 8: Gemini classification.**

The user asked for AI classification with a Google key stored the same way as
the Notion token. The `Categorizer` interface from Phase 2 took it without
modification — the only change to existing code was making the categorizer an
injected argument rather than a module singleton, so `capture.ts` and the
repository now receive one.

Verified against the live API rather than documentation, because
`ai.google.dev` is unreachable from this environment while
`generativelanguage.googleapis.com` is not:

- A CORS preflight from `https://itaigree.github.io` returns
  `access-control-allow-origin` echoing that origin and
  `access-control-allow-headers: content-type,x-goog-api-key`. Browser calls
  work and the key travels in a header, not the URL.
- A request with an invalid key returns the error envelope the code parses,
  with `details[].reason === 'API_KEY_INVALID'`.
- A browser driving the built app reached Google and rendered the mapped
  message, so CORS, auth transport and error handling are confirmed end to end.

What could not be verified: a *successful* classification, which needs a real
key. Two defences cover that uncertainty rather than a guess:

1. **Model ids are not hardcoded.** The app calls ListModels with the user's key
   and scores the results, so it cannot ship a model id that has since retired.
2. **A rejected request option is retried with a minimal body**, so a
   `generationConfig` field name going stale degrades instead of breaking.

`maxOutputTokens` is deliberately not sent: on a reasoning model a small budget
is consumed thinking and the reply comes back empty.

Any Gemini failure falls back to the keyword rules and the task is still saved.
A task filed in the wrong category beats a task that was never captured.

**2026-11-05 — Scope change: GitHub Pages instead of Vercel (Phases 9-11).**

The user asked whether GitHub Pages could host this. My first answer was that it
could not, for two reasons: a static site cannot hold a secret, and Notion's API
would block browser calls on CORS. **The second reason was wrong.** The Notion
SDK's own README states the API sends CORS headers and ships a
`dangerouslyAllowBrowser` flag for exactly this case. That changes the verdict:
a static, bring-your-own-token app is viable, and the user chose it.

Phases affected by the change:

- **Phase 3 and 4 are superseded.** The API routes and `src/lib/http.ts` are
  deleted; `notion.ts` and `tasks.ts` are rewritten to run in the browser against
  a config object rather than `process.env`.
- **Phase 6 is amended.** `page.tsx` is a client component; the read-only
  `SetupNotice` becomes an interactive connect form.
- **Phases 2 and 5 are untouched.** `parse.ts`, `categorize/`, `capture.ts`,
  `views.ts` and `notion-mapping.ts` are pure and moved across unchanged — the
  reason the rewrite is small.

Accepted risk, stated to the user before building: local storage is scoped to
the *origin*, so on `itaigree.github.io` every GitHub Pages project under that
domain can read the stored token. The user accepted this rather than buy a
custom domain. A custom domain remains the fix; `NEXT_PUBLIC_BASE_PATH` is
configurable so moving to one needs no code change.

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
