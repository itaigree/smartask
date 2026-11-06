# SmartTask

Capture a task in plain language, let it file itself, keep everything in Notion.

You type `pay the electricity bill friday !! #home @bills` and SmartTask pulls
out the due date, the priority, the project and the tags, works out that it is a
**Finance** task, and writes it to a Notion database. The web app then reads
those tasks back and shows them in views worth looking at — what to do *now*,
what is due today, what is coming — instead of one flat list.

Notion is the database. There is no second store to host or back up, and you
can edit any task in Notion itself and see the change in the app.

**There is no server.** The app is a static site on GitHub Pages. You paste your
Notion token into it once, it is kept in your browser on your own device, and
your browser talks to Notion directly. Nothing is stored anywhere else and
nothing passes through a third party.

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

You need a free Notion account. No Node.js, no terminal, no hosting account.

### 1. Create a Notion integration

Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) →
**New integration** → name it and pick your workspace. Copy the **Internal
Integration Secret** — it starts with `ntn_`.

### 2. Create the tasks database

Either run `npm run setup:notion` locally (see Development), or create a database
by hand with the properties listed under [Database schema](#database-schema).

### 3. Connect the integration to it

Open the database in Notion → **•••** → **Connections** → add your integration.

**This step is not optional and it is the one people miss.** A Notion integration
can see nothing until you share a page with it, and Notion reports anything it
cannot see as *not found* rather than *forbidden* — so skipping this looks
exactly like a wrong database id.

### 4. Publish the site

Push to `main`. The workflow in `.github/workflows/deploy.yml` enables GitHub
Pages, builds the site and publishes it to `https://<you>.github.io/<repo>/`.

If an organisation policy stops the workflow enabling Pages, set it by hand —
**Settings → Pages → Build and deployment → Source: GitHub Actions** — and
re-run the failed workflow.

### 5. Open it and connect

Open that URL, paste the token and the database link, press **Connect**. On a
phone, use **Add to Home Screen** (iOS) or **Install app** (Android) to get an
icon and a full-screen window.

## AI classification (optional)

Out of the box, categories come from keyword rules in
`src/lib/categorize/rules.ts` — instant, free, offline, and sometimes wrong.

Press **✦** in the header to add a free [Google AI Studio
key](https://aistudio.google.com/apikey) and Gemini classifies instead, reading
the whole task rather than matching words. Dates, priority, `#project` and
`@tag` are still parsed on your device either way — the deterministic parser is
better at those and costs nothing.

- **The model is not hardcoded.** On connecting, the app asks Google which
  models your key can use and picks the cheapest suitable one. You can change it
  in the same panel, and **Test it** runs a real classification so you can see
  it work.
- **Any language.** Gemini classifies by meaning, so Hebrew (or anything else)
  works. The keyword rules are English-only, which is why they file non-English
  tasks to Inbox when AI is off.
- **You always see who decided.** After each capture, a line under the box says
  whether Gemini or the keyword rules filed the task — and, if Gemini failed,
  why. The task is saved either way; you get a note, never a lost task.
- **Sort with Gemini** appears whenever open tasks sit in Inbox — tasks captured
  before AI was on, or while it was failing. It works through them one at a
  time, spaced out for the free tier, and stops with a reason if Gemini refuses.
- **Restrict the key.** Unlike the Notion token, a Google API key can be locked
  to one website. In [Google Cloud
  credentials](https://console.cloud.google.com/apis/credentials), set an
  **HTTP referrer** restriction to your Pages address. Then a copied key is
  useless anywhere else. Two minutes well spent.

## Where your tokens are kept

In your browser's local storage, on the device you typed them into. They are
never committed, never part of the built JavaScript, and never sent anywhere
except `api.notion.com` and, if you enable it, `generativelanguage.googleapis.com`. The Notion API sends CORS headers, which is what makes a
server unnecessary.

Two things worth knowing:

- **Local storage is scoped to the domain, not the app.** On
  `<you>.github.io`, any other project you publish under that domain can read the
  stored token. A custom domain gives this app its own origin and removes that.
  Set `NEXT_PUBLIC_BASE_PATH` to `''` in the workflow when you move to one.
- **Anything that runs on the page can read the token.** That is the trade for
  having no server. Use the ⏻ button to forget it on a shared device.

If that trade is wrong for you, the app can be put back behind a server — the
token then lives in an environment variable and never reaches the browser. See
the Status log in `PLAN.md` for what that change involves.

## Development

```bash
npm run dev           # dev server
npm test              # 51 unit tests, no network needed
npm run lint          # tsc --noEmit
npm run build         # static export into out/
npm run check:notion  # diagnose a Notion connection (read-only)
npm run setup:notion  # create the tasks database (run once)
```

The two `*:notion` scripts are local developer tools and read `NOTION_TOKEN`
and `NOTION_DATABASE_ID` from `.env.local`. The deployed app does not use them
or any environment variable — it reads the credentials you type into it.

`npm run build` produces `out/`, a folder of plain files. Set
`NEXT_PUBLIC_BASE_PATH=/<repo>` when building for a GitHub project site, as the
workflow does; leave it unset for a custom domain or local preview.

### How it fits together

```
.github/workflows/deploy.yml   builds and publishes to GitHub Pages on push to main
src/
  app/
    page.tsx          a static shell around the client app
    manifest.ts       installable-on-phone metadata
  components/
    App.tsx           connect screen or board
    ConnectForm.tsx   takes the token, states where it is stored
    TaskBoard.tsx     loads, renders and mutates through the repository
    QuickAdd.tsx  TaskCard.tsx  ViewTabs.tsx  Chips.tsx
  lib/
    parse.ts          text -> structured draft            (pure, tested)
    categorize/       Categorizer interface + rules       (pure, tested)
    capture.ts        parse + categorize pipeline         (pure, tested)
    views.ts          focus scoring and grouping          (pure, tested)
    notion-mapping.ts Notion page <-> Task                (pure, tested)
    config.ts         token + database id in localStorage (pure helpers tested)
    notion.ts         browser Notion client, error messages
    tasks.ts          repository factory over a config
    cache.ts          20s read cache, cleared on every write
```

The pure modules take `now` as an argument rather than reading the clock, which
is why they are testable without mocks — and why "tomorrow" means *your*
tomorrow. Those modules survived the move from a server app to a static one
without a single change.

### Adding another classifier

`src/lib/categorize/index.ts` defines a `Categorizer` interface, and the
categorizer is injected into `capture.ts` and the task repository rather than
looked up globally. `gemini.ts` is one implementation; another provider means
one new file and one line in `App.tsx`. Nothing else imports the rules
directly.

## Database schema

`npm run setup:notion` creates exactly this. To build it by hand, the names and
types must match — the app reads properties by name.

| Property | Type | Notes |
|---|---|---|
| `Name` | Title | The task title |
| `Category` | Select | Work, Personal, Errands, Health, Finance, Learning, Home, Inbox |
| `Priority` | Select | Urgent, High, Normal, Low |
| `Status` | Select | Todo, Doing, Done — **a Select, not Notion's Status type** |
| `Due` | Date | |
| `Project` | Text | |
| `Tags` | Multi-select | |
| `Note` | Text | |
| `Completed` | Date | Stamped when a task is ticked done |

`Status` is the one to watch: Notion's native *Status* property looks almost
identical in the editor but is a different type over the API, and the app will
not read it.

## Troubleshooting

The app shows Notion's failures in a red banner rather than breaking, so the
message on screen is the thing to read. The failures worth knowing about:

| What you see | What it means |
|---|---|
| `Notion rejected the token` | The token is wrong or was regenerated. Press ⏻ to forget it and paste it again, in full. |
| `Notion cannot find that page or database` | Almost always the missing **Connections** step, not a wrong id. Notion reports anything an integration was never given access to as *not found*, never as *forbidden* — so "not found" usually means "not shared". |
| `Could not reach Notion` | A network problem, not an auth one: no connection, or a VPN, proxy or firewall blocking `api.notion.com`. |
| `Notion rejected the data` | The database schema does not match the table above — usually a property renamed by hand in Notion. |
| `Notion is rate limiting` | Roughly 3 requests/second. Wait and retry. |
| The connect screen keeps coming back | The browser is refusing to store anything. Private browsing usually causes this; try a normal window. |

`npm run check:notion` does the same checks from a terminal and names the broken
link, if you have the repo cloned locally.

A thing worth internalising: **the token says *who* the app is, and the
Connections step says *what it may see*.** They are separate, and a valid token
with no page access looks exactly like a wrong id.

## Notes and limits

- **Notion rate limits** at roughly 3 requests/second. Fine for one person; the
  app caches reads for 20 seconds and clears that cache on every write.
- **Deleting** moves the Notion page to the trash. Nothing is destroyed, and you
  can restore it from Notion.
- **Syncing.** Everything you do in the app reaches Notion immediately — there
  is no schedule. Edits made *in Notion* reach the app whenever you switch back
  to it (at most once every 10 seconds), or when you tap ↻. Nothing is fetched
  while the app sits unused. If a new task does not show in Notion, that is
  Notion's own view not redrawing: pull down to refresh on a phone, or reload.
- **Not in v1:** recurring tasks, reminders, multiple users.
- **Each browser connects separately.** The token lives on one device, so a
  phone and a laptop each need it pasted once. The tasks are shared because
  Notion holds them; only the credential is per-device.
- **The site is public, your data is not.** A GitHub Pages site is readable by
  anyone, but it ships no credentials — a visitor sees the connect screen and
  nothing of yours.
