# SmartTask

Capture a task in plain language and let it file itself — on your phone, or in
your own Notion.

You type `pay the electricity bill friday !! #home @bills` and SmartTask pulls
out the due date, the priority, the project and the tags, works out that it is a
**Finance** task, and saves it. The app then shows your tasks in views worth
looking at — what to do *now*, what is due today, what is coming — instead of
one flat list.

Your tasks live in one of two places — you choose on first launch:

- **On this phone only.** Nothing to set up and no account. Tasks are kept in
  the browser on that device, with a backup file you can download and restore.
- **In Notion.** Tasks go into a Notion database you own, so you can see and
  edit them in Notion on any device.

Voice input and Gemini sorting work the same with either.

**There is no server either way.** The app is a static site on GitHub Pages.
Any token or key you give it is kept in your browser on your own device, and
your browser talks to Notion and Gemini directly. Nothing passes through a
third party.

## What the capture box understands

| You type | It sets |
|---|---|
| `today`, `tonight`, `tomorrow`, `friday`, `next monday`, `in 3 days`, `in 2 weeks`, `next week`, `next month` | Due date |
| `25/12`, `25/12/2027`, `2026-12-25`, `dec 25`, `3 march 2028` | Due date. A day and month with no year that has already passed means next year. |
| `25.12` | Due date at the start, after `by` or `on`, or in Hebrew. After another English word it stays in the title (`python 3.12`). |
| `עד 10/11`, `ב-10/11`, `ב10.11` | Due date — the Hebrew preposition leaves the title with it |
| `!` / `!!` (or more), as a word of their own | High / Urgent priority |
| `asap`, `as soon as possible`, `top priority`, `now!` | Urgent, anywhere in the task |
| `high priority` | High, anywhere |
| `not urgent`, `non-urgent`, `not important`, `low priority`, `no rush` | Low, anywhere |
| `urgent`, `critical` / `important`, `soon` / `someday`, `whenever` | Urgent / High / Low — only at the start or end of the task (`Urgent: call the bank`), in any letter case |
| `#project` | Project (the last one, if there are several) |
| `@tag` | Tag. `@urgent`, `@important`, `@someday`, `#asap` and the like also set the priority when nothing else did. |
| anything after ` // ` | Note |

`friday` is the coming Friday — today, if it is Friday. `next friday` is the one
a week after that.

The box is a single line, so a pasted line break becomes a space and does not
start a note. Use ` // ` for that: `renew passport // last time it took 3 weeks`.

The parser would rather miss a date than invent one. Numbers that are probably
quantities, prices, times or versions — `1.5 ליטר`, `1/2 kg`, `at 9.05`,
`python 3.12`, `24/7` — stay in the title, and so does anything inside a link.
With AI on, Gemini still catches a date the parser left alone. Impossible dates
such as `31/02` are never rolled into another day.

Whatever is left becomes the title, with the matched phrases removed — so
`call the bank about the overdraft tomorrow` is titled *call the bank about the
overdraft* and due tomorrow. Before you add it, a line under the box shows what
will be saved.

With AI off, the category comes from English keywords in the task. Two rules
decide it:

- A **tag** that names a category wins outright — `@work` is a deliberate statement.
- A **project** that names a category is only a fallback, used when nothing else
  matched. `#home` on "pay the electricity bill" means the household project,
  so the task is still Finance.

## Adding, ticking and deleting

- **Add** saves the task. While it saves, the button says *Saving…* and the box
  is read-only, then it clears for the next task. If the save fails, the text is
  still in the box — tap Add to try again.
- If the app closes in the middle of a save (a back gesture, the phone closing
  the tab), the text is back in the box next time, with a note asking you to
  check it is not already in your list before adding it again.
- **✓** completes a task. It stays where it is, struck through, until 2 seconds
  pass without a tap on the list, so a wrong tap can be undone by tapping ✓
  again. Then it moves to **Done**.
- **✕** deletes, after asking. With Notion the page goes to Notion's trash; on
  the phone it is gone for good.

After each add, a line under the box says who filed the task and where: Gemini,
or the keyword rules — and if Gemini failed, why. The task is saved either way.

## The views

| View | Shows |
|---|---|
| **Focus** | The five tasks most worth doing, scored on priority, urgency and age. An overdue Low task outranks a Normal task due next week. |
| **Today** | Overdue first, then due today. Nothing else. |
| **Upcoming** | The next seven days, grouped by day, with undated tasks at the bottom. |
| **All** | Every open task grouped by category. |
| **Done** | Completed in the last 14 days. |

## Setup

### Publish the site

Only if you host your own copy (a fork or a new repository).

1. **Once, by hand:** in the repository, **Settings → Pages → Build and
   deployment → Source: GitHub Actions**. The workflow cannot turn Pages on
   itself — that needs admin rights its token never has — so until this is
   done every run stops at its first step with "GitHub Pages is not turned on".
2. Push to `main`. The workflow in `.github/workflows/deploy.yml` runs the
   tests, builds the site and publishes it to `https://<you>.github.io/<repo>/`.

### Phone only

Open the app and choose **On this phone only**. That is the whole setup.

Then, from the browser menu, **Add to Home screen** (Android) or **Share → Add
to Home Screen** (iPhone) for an icon and a full-screen window.

Because the tasks live in that one browser, use **Back up** at the bottom of
the board now and then, and keep the file somewhere other than the phone.
**Restore** merges a backup back in — restoring twice adds nothing, and an old
backup never deletes newer tasks.

### With Notion

You need a free Notion account. No Node.js, no terminal.

#### 1. Create a Notion integration

Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) →
**New integration** → name it and pick your workspace. Copy the **Internal
Integration Secret** — it starts with `ntn_`. Leave its **Capabilities** at
Read, Update and Insert content (the defaults); the app needs all three.

#### 2. Create the tasks database

Either run `npm run setup:notion` locally (see [Development](#development)), or
create a database by hand with the properties listed under [Database
schema](#database-schema).

#### 3. Connect the integration to it

Open the database in Notion → **•••** → **Connections** → add your integration.

**This step is not optional and it is the one people miss.** A Notion integration
can see nothing until you share a page with it, and Notion reports anything it
cannot see as *not found* rather than *forbidden* — so skipping this looks
exactly like a wrong database id.

#### 4. Open the app and connect

Open the site, choose **Sync with Notion**, paste the token and the database
link, and press **Connect**. On a phone, use **Add to Home Screen** (iPhone) or
**Install app** (Android) to get an icon and a full-screen window.

## Changing a task's category

Tap the category on any task. A sheet lists every category, with the current
one ticked — tap another to move the task, or type a name and tap **Create** for
a new category.

New categories get their own colour and their own group in the **All** view,
and Gemini starts filing tasks into them too. Categories created on another
device, or added to the Notion database directly, show up on their own. One
that no task uses any more can be removed with its ✕; the built-in ones cannot.

Names can be up to 40 characters, in any language, but cannot contain a comma —
Notion does not allow commas in its options.

## AI classification (optional)

Out of the box, categories come from keyword rules in
`src/lib/categorize/rules.ts` — instant, free, offline, English-only, and
sometimes wrong. That is why, with AI off, a Hebrew task goes to Inbox.

Press **✦ AI** in the header to add a free [Google AI Studio
key](https://aistudio.google.com/apikey) and Gemini classifies instead, reading
the whole task rather than matching words. Dates, priority, `#project` and
`@tag` are still parsed on your device either way — the parser is better at
those and costs nothing.

- **The model is not hardcoded.** On connecting, the app asks Google which
  models your key can use and picks the cheapest suitable one. You can change it
  in the same panel, and **Test it** runs a real classification so you can see
  it work.
- **Any language, dates included.** Gemini classifies by meaning, so Hebrew (or
  anything else) works, and it also finds the due date — "מחר", "ביום שלישי",
  "בעוד שבוע" — taking the date words out of the title. A date the parser
  already understood (English "friday", "25/12") always wins; Gemini only fills
  the gap. Gemini's title is used only if every word in it is already in yours.
- **Your categories first, a new one only when nothing fits.** Gemini sees
  every category you have — the built-ins and your own — and files the task
  into the best fit, even a broader one. Only when none of them fits does it
  create a new, short, general category ("Pets", "Car", "Wedding"); the line
  under the box says so, and the new category is then offered for every later
  task. A near-twin of an existing one ("Cars" next to "Car") is never created.
  If you dislike a new category, tap the task's category to move it; an unused
  category can be removed from the same list.
- **It never costs you a task.** If Gemini fails, or does not answer within 15
  seconds, the keyword rules file the task and the line under the box says why.
- **Sort with Gemini** appears whenever open tasks sit in Inbox — tasks captured
  before AI was on, or while it was failing. It works through them one at a
  time, spaced out for the free tier, and stops with a reason if Gemini refuses.
  A task you move, tick or delete while it runs is left alone, and ⏻ or a change
  to the AI settings stops it.
- **Restrict the key.** Unlike the Notion token, a Google API key can be limited
  to websites. In [Google Cloud
  credentials](https://console.cloud.google.com/apis/credentials), open the key,
  choose **Websites** under *Application restrictions*, and add
  `https://<you>.github.io/*` — your Pages address without the `/<repo>/` part
  (with a custom domain, `https://<your domain>/*`). The browser tells Google
  only the site's address, not the page, so a pattern that includes
  `/<repo>/` blocks every request. This stops other websites from using a copied
  key; it does not stop a script, which can claim any address, so keep the key
  private anyway. If Gemini stops working right after you add a restriction,
  check that pattern first.

## Voice input

Tap the 🎤 next to the box and speak. Words appear as you talk, and the mic
stops when you stop talking (or tap it to finish sooner). Then **check the
text, fix anything misheard, and tap Add** — the box clears for the next task.

While the mic is listening, the box is read-only and Add is unavailable, on
purpose: the words on screen are still provisional until speech ends, and
saving them early would store a cut-off task.

The small **🎤 עברית / English** button under the box switches the language and
remembers your choice. It starts in Hebrew on a phone set up with Hebrew.

It uses the browser's built-in speech recognition, so it is free and needs no
key. Support varies:

- **Android (Chrome):** works, including when installed to the home screen.
- **iPhone (Safari tab):** generally works.
- **iPhone, installed to the home screen:** may refuse. The app says so.

Wherever it does not work, the 🎤 on your **keyboard** does — it dictates Hebrew
and English into any text box, this one included.

## Where your tokens are kept

In your browser's local storage, on the device you typed them into. They are
never committed, never part of the built JavaScript, and never sent anywhere
except `api.notion.com` and, if you enable it,
`generativelanguage.googleapis.com`. The Notion API sends CORS headers, which is
what makes a server unnecessary.

Two things worth knowing:

- **Local storage is scoped to the domain, not the app.** On
  `<you>.github.io`, any other project you publish under that domain can read the
  stored token. A custom domain gives this app its own origin and removes that.
  Set `NEXT_PUBLIC_BASE_PATH` to `''` in the workflow when you move to one.
- **Anything that runs on the page can read the token.** That is the trade for
  having no server. Use the ⏻ button to forget it on a shared device. It then
  asks whether to forget the Gemini key and your custom categories too — say
  yes on a shared device. (The Gemini key alone can be removed any time with
  **Remove key** under **✦ AI**.) Tasks are never deleted: Notion keeps its
  own, and phone-only tasks stay on the device.

If that trade is wrong for you, the app can be put back behind a server — the
token then lives in an environment variable and never reaches the browser. See
the Status log in `PLAN.md` for what that change involves.

## Development

Needs Node.js 22.18 or newer (`.nvmrc` has the major version). The tests and
`check:notion` run TypeScript files directly, which older Node cannot do.

```bash
npm run dev           # dev server
npm test              # unit tests, no network needed
npm run lint          # tsc --noEmit
npm run build         # static export into out/
npm run check:notion  # diagnose a Notion connection (read-only)
npm run setup:notion  # create the tasks database (run once)
```

The two `*:notion` scripts are local developer tools. Copy `.env.example` to
`.env.local` and fill it in; they read `NOTION_TOKEN`, `NOTION_PARENT_PAGE_ID`
and `NOTION_DATABASE_ID` from there. The deployed app does not use them or any
environment variable — it reads the credentials you type into it.

`npm run build` produces `out/`, a folder of plain files; there is no `npm
start`. Set `NEXT_PUBLIC_BASE_PATH=/<repo>` when building for a GitHub project
site, as the workflow does; leave it unset for a custom domain or a local look
at the build, which any static file server can show — for example
`python3 -m http.server -d out`.

### How it fits together

```
.github/workflows/deploy.yml   builds and publishes to GitHub Pages on push to main
scripts/                       setup-notion and check-notion, for developers
src/
  app/
    page.tsx            a static shell around the client app
    manifest.ts         installable-on-phone metadata
  components/
    App.tsx             storage choice, connect screen or board; owns the credentials
    StorageChoice.tsx   first launch: this phone or Notion
    ConnectForm.tsx     takes the Notion token, states where it is stored
    TaskBoard.tsx       loads, shows and saves tasks through the repository
    QuickAdd.tsx        the capture box: live preview, voice, restored text
    AiSettings.tsx      Gemini key and model
    CategoryPicker.tsx  the sheet for moving a task or creating a category
    LocalBackup.tsx     back up and restore, phone-only mode
    TaskCard.tsx  ViewTabs.tsx  Chips.tsx  VoiceButton.tsx
  lib/
    parse.ts            text -> structured draft                (pure, tested)
    categorize/         Categorizer interface, rules, Gemini    (tested)
    capture.ts          parse + categorize pipeline             (pure, tested)
    categories.ts       built-in and custom categories          (pure, tested)
    views.ts            focus scoring and grouping              (pure, tested)
    board-sync.ts       merges reads with saves still running   (pure, tested)
    recategorize.ts     Sort with Gemini                        (tested)
    voice-session.ts    timing of one voice capture             (tested)
    speech.ts           browser speech recognition helpers      (tested)
    notion-mapping.ts   Notion page <-> Task                    (pure, tested)
    notion.ts           browser Notion client, error messages
    tasks.ts            the Notion repository
    local-store.ts      the phone-only repository, backup files (tested)
    config.ts           credentials and settings in localStorage (pure helpers tested)
    cache.ts            20s read cache, cleared on every write
```

The pure modules take `now` as an argument rather than reading the clock, which
is why they are testable without mocks — and why "tomorrow" means *your*
tomorrow.

### Adding another classifier

`src/lib/categorize/index.ts` defines a `Categorizer` interface, and the
categorizer is injected into `capture.ts` and the task repository rather than
looked up globally. `gemini.ts` is one implementation; another provider is one
new file, plus choosing it in `App.tsx`. Nothing else imports the rules
directly.

## Database schema

`npm run setup:notion` creates exactly this. To build it by hand, the names and
types must match — the app reads properties by name.

| Property | Type | Notes |
|---|---|---|
| `Name` | Title | The task title |
| `Category` | Select | Work, Personal, Errands, Health, Finance, Learning, Home, Inbox — plus any you create, added the first time a task uses one |
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

## Opening Notion

With Notion connected, **Notion ↗** at the top of the app — and the link in the
footer — opens your tasks database. On a phone with the Notion app installed it
opens there. Each task's own ↗ opens that one task.

## Troubleshooting

The app shows Notion's failures in a red banner rather than breaking, so the
message on screen is the thing to read. The failures worth knowing about:

| What you see | What it means |
|---|---|
| `Notion rejected the token` | The token is wrong or was regenerated. Press ⏻ to forget it and paste it again, in full. |
| `Notion cannot find …` | Almost always the missing **Connections** step, not a wrong id. Notion reports anything an integration was never given access to as *not found*, never as *forbidden* — so "not found" usually means "not shared". |
| The list loads, but every add, tick or change fails | The integration may read but not write. At [notion.so/my-integrations](https://www.notion.so/my-integrations) → your integration → **Capabilities**, turn on Read, Update and Insert content. |
| `Could not reach Notion` | A network problem, not an auth one: no connection, or a VPN, proxy or firewall blocking `api.notion.com`. |
| `Notion rejected the data` | The database schema does not match the table above — usually a property renamed by hand in Notion. |
| `Notion is rate limiting` | Roughly 3 requests/second. Wait and retry. |
| `This browser will not let the app save anything`, or the setup screen comes back every time | The browser is refusing to store anything. Private browsing usually causes this; try a normal window. |

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
- **Phone-only, two windows.** The installed app and a browser tab on the same
  phone share the same tasks, and each picks up the other's changes.
- **Not in v1:** recurring tasks, reminders, multiple users.
- **Switching storage never deletes anything.** The ⏻ button returns you to the
  choice screen. Phone-only tasks stay on the device and come back if you pick
  phone-only again; they are not copied into Notion.
- **Each browser connects separately.** The token lives on one device, so a
  phone and a laptop each need it pasted once. The tasks are shared because
  Notion holds them; only the credential is per-device.
- **The site is public, your data is not.** A GitHub Pages site is readable by
  anyone, but it ships no credentials — a visitor sees the first-launch screen
  and nothing of yours.
