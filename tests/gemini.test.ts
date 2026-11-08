import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrompt, calendarLines, sanitizeExtraction,
  parseGeminiReply, extractText, describeGeminiError,
  scoreModel, pickDefaultModel, listGeminiModels, createGeminiCategorizer,
  classifyWithGemini, GeminiError, acceptNewCategory, GEMINI_TIMEOUT_MS,
  isDateCut, modelChoices,
} from '../src/lib/categorize/gemini.ts';
import { rulesCategorizer } from '../src/lib/categorize/rules.ts';
import { captureDraft } from '../src/lib/capture.ts';
import { CATEGORIES } from '../src/lib/types.ts';

/** Swap global fetch for one call, then put it back. */
async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const reply = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

test('the prompt offers every category and the task itself', () => {
  const prompt = buildPrompt({ title: 'pay the rent', note: 'standing order', tags: ['bills'] });
  for (const category of CATEGORIES) assert.match(prompt, new RegExp(`- ${category}:`));
  assert.match(prompt, /pay the rent/);
  assert.match(prompt, /standing order/);
  assert.match(prompt, /bills/);
});

test('the prompt tells Gemini tasks may be Hebrew and to commit rather than say Inbox', () => {
  const prompt = buildPrompt({ title: 'בקשה אתית' });
  assert.match(prompt, /any language/i);
  assert.match(prompt, /Hebrew/);
  assert.match(prompt, /English category name/);
  assert.match(prompt, /Inbox: LAST RESORT/);
  assert.match(prompt, /Do not choose Inbox just because the task is short/);
  assert.ok(prompt.includes('"בקשה אתית"'), 'the Hebrew task reaches the prompt intact');
  assert.match(prompt, /-> Finance/, 'worked examples are included');
});

test('academic work is described under Work, so research admin lands there', () => {
  const prompt = buildPrompt({ title: 'x' });
  const work = prompt.split('\n').find((l) => l.startsWith('- Work:')) ?? '';
  assert.match(work, /research/);
  assert.match(work, /ethics/);
});

test('a clean JSON reply is parsed', () => {
  const signal = parseGeminiReply('{"category":"Finance","confidence":0.9,"reason":"a bill"}');
  assert.deepEqual(signal, {
    category: 'Finance', confidence: 0.9, reason: 'a bill',
    extracted: { due: null, title: null },
  });
});

test('code fences and surrounding prose are tolerated', () => {
  assert.equal(parseGeminiReply('```json\n{"category":"Health"}\n```')?.category, 'Health');
  assert.equal(
    parseGeminiReply('Sure! Here you go:\n{"category":"Work","confidence":1}\nHope that helps.')
      ?.category,
    'Work',
  );
});

test('a bare category word still works', () => {
  assert.equal(parseGeminiReply('Errands')?.category, 'Errands');
  assert.equal(parseGeminiReply('I would file this under Learning.')?.category, 'Learning');
});

test('an invented category is rejected rather than trusted', () => {
  assert.equal(parseGeminiReply('{"category":"Shopping","confidence":1}'), null);
  assert.equal(parseGeminiReply('{"category":42}'), null);
  assert.equal(parseGeminiReply('no idea'), null);
  assert.equal(parseGeminiReply(''), null);
});

test('confidence is clamped and defaulted', () => {
  assert.equal(parseGeminiReply('{"category":"Work","confidence":5}')?.confidence, 1);
  assert.equal(parseGeminiReply('{"category":"Work","confidence":-2}')?.confidence, 0);
  assert.equal(parseGeminiReply('{"category":"Work"}')?.confidence, 0.8);
  assert.equal(parseGeminiReply('{"category":"Work","confidence":"nope"}')?.confidence, 0.8);
});

test('text is read out of the response, and a blocked reply yields empty', () => {
  assert.equal(extractText(reply('hello')), 'hello');
  assert.equal(extractText({ candidates: [{ finishReason: 'SAFETY', content: {} }] }), '');
  assert.equal(extractText({}), '');
  assert.equal(extractText(null), '');
});

test('Google errors become advice, not raw JSON', () => {
  const invalidKey = {
    error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT',
      details: [{ reason: 'API_KEY_INVALID' }] },
  };
  assert.match(describeGeminiError(invalidKey, 400), /rejected the API key/);
  assert.match(describeGeminiError({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429), /rate limit/);
  assert.match(describeGeminiError({}, 404), /not available to your key/);
  assert.equal(describeGeminiError({ error: { message: 'Something odd' } }, 500), 'Something odd');
});

test('model scoring prefers a cheap, stable, text model', () => {
  assert.ok(scoreModel('gemini-2.0-flash') > scoreModel('gemini-2.0-pro'), 'flash over pro');
  assert.ok(scoreModel('gemini-2.5-flash') > scoreModel('gemini-1.5-flash'), 'newer wins');
  assert.ok(
    scoreModel('gemini-2.0-flash') > scoreModel('gemini-2.0-flash-exp'),
    'stable over experimental',
  );
  assert.ok(scoreModel('text-embedding-004') < 0, 'embedding models are unusable here');
  assert.ok(scoreModel('imagen-3.0-generate') < 0);
  assert.ok(scoreModel('gemini-2.0-flash-thinking-exp') < scoreModel('gemini-2.0-flash'));
});

test('the model list is filtered, sorted and stripped of the models/ prefix', async () => {
  const body = {
    models: [
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-1.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
    ],
  };
  const models = await withFetch(async () => jsonResponse(body), () => listGeminiModels('k'));

  assert.deepEqual(models.map((m) => m.id), ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-2.5-pro']);
  assert.equal(pickDefaultModel(models), 'gemini-2.5-flash');
  assert.equal(pickDefaultModel([]), null);
});

test('the key travels in a header, never in the URL', async () => {
  let seenUrl = '';
  let seenKey: string | null = null;
  await withFetch(async (url, init) => {
    seenUrl = String(url);
    seenKey = new Headers(init?.headers).get('x-goog-api-key');
    return jsonResponse({ models: [] });
  }, () => listGeminiModels('super-secret-key'));

  assert.equal(seenKey, 'super-secret-key');
  assert.ok(!seenUrl.includes('super-secret-key'), 'the key must not leak into the URL');
});

test('a bad key surfaces as a GeminiError with readable advice', async () => {
  await withFetch(
    async () => jsonResponse({ error: { details: [{ reason: 'API_KEY_INVALID' }] } }, 400),
    async () => {
      await assert.rejects(
        () => classifyWithGemini({ apiKey: 'bad', model: 'gemini-2.0-flash' }, { title: 'x' }),
        (e: Error) => e instanceof GeminiError && /rejected the API key/.test(e.message),
      );
    },
  );
});

test('a rejected request option is retried with a minimal body', async () => {
  const bodies: string[] = [];
  const signal = await withFetch(async (_url, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) {
      return jsonResponse({ error: { message: 'Unknown name "temperature": invalid field.' } }, 400);
    }
    return jsonResponse(reply('{"category":"Home"}'));
  }, () => classifyWithGemini({ apiKey: 'k', model: 'm' }, { title: 'fix the door' }));

  assert.equal(signal.category, 'Home');
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].includes('generationConfig'));
  assert.ok(!bodies[1].includes('generationConfig'), 'the retry drops the rejected option');
});

test('capture never breaks: any Gemini failure falls back to the rules', async () => {
  const errors: string[] = [];
  const categorizer = createGeminiCategorizer(
    { apiKey: 'k', model: 'm' },
    rulesCategorizer,
    (m) => errors.push(m),
  );

  const signal = await withFetch(
    async () => { throw new Error('network down'); },
    () => categorizer.categorize({ title: 'pay the electricity bill' }),
  );

  assert.equal(signal.category, 'Finance', 'the keyword rules answered instead');
  assert.equal(signal.source, 'rules');
  assert.match(signal.fallbackReason ?? '', /Could not reach Gemini/,
    'the fallback carries its reason so the UI can show it');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Could not reach Gemini/);
});

test('when Gemini answers, its verdict is used over the rules', async () => {
  const categorizer = createGeminiCategorizer({ apiKey: 'k', model: 'm' }, rulesCategorizer);
  const signal = await withFetch(
    async () => jsonResponse(reply('{"category":"Work","confidence":0.95,"reason":"client bill"}')),
    // The rules would say Finance; Gemini sees the wider context.
    () => categorizer.categorize({ title: 'pay the contractor invoice', project: 'acme' }),
  );
  assert.equal(signal.category, 'Work');
  assert.equal(signal.reason, 'client bill');
  assert.equal(signal.source, 'gemini');
  assert.equal(signal.fallbackReason, undefined);
});

test('a Hebrew task Gemini classifies is filed by Gemini, not left in Inbox', async () => {
  const categorizer = createGeminiCategorizer({ apiKey: 'k', model: 'm' }, rulesCategorizer);
  const signal = await withFetch(
    async () => jsonResponse(reply('{"category":"Work","confidence":0.85,"reason":"ethics committee request"}')),
    () => categorizer.categorize({ title: 'בקשה אתית' }),
  );
  assert.equal(signal.category, 'Work');
  assert.equal(signal.source, 'gemini');
});

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

// Friday 6 November 2026, local time.
const FRI = new Date(2026, 10, 6, 9, 0, 0);

test('the prompt states today and writes out the next two weeks', () => {
  const prompt = buildPrompt({ title: 'לשלם חשבון חשמל מחר', now: FRI });
  assert.match(prompt, /Today is Friday, 2026-11-06/);
  assert.match(prompt, /Saturday 2026-11-07/);
  assert.match(prompt, /Thursday 2026-11-12/);
  assert.match(prompt, /"מחר" is tomorrow/);
  assert.match(prompt, /do not translate, rephrase or shorten/);
  assert.match(prompt, /"due": "<YYYY-MM-DD or null>"/);
});

test('the calendar is fourteen correct days with today and tomorrow marked', () => {
  const lines = calendarLines(FRI);
  assert.equal(lines.length, 14);
  assert.equal(lines[0].trim(), 'Friday 2026-11-06 (today)');
  assert.equal(lines[1].trim(), 'Saturday 2026-11-07 (tomorrow)');
  assert.equal(lines[2].trim(), 'Sunday 2026-11-08');
  assert.equal(lines[13].trim(), 'Thursday 2026-11-19');
});

test('a plausible date and a word-removing title both survive', () => {
  const out = sanitizeExtraction(
    { due: '2026-11-07', title: 'לשלם חשבון חשמל' },
    'לשלם חשבון חשמל מחר',
    FRI,
  );
  assert.deepEqual(out, { due: '2026-11-07', title: 'לשלם חשבון חשמל' });
});

test('impossible or implausible dates are dropped', () => {
  const due = (d: string) => sanitizeExtraction({ due: d, title: null }, 'x', FRI).due;
  assert.equal(due('2026-02-31'), null, 'not a real date');
  assert.equal(due('tomorrow'), null, 'not ISO');
  assert.equal(due('2026-11-7'), null, 'not zero-padded');
  assert.equal(due('2020-01-01'), null, 'years in the past');
  assert.equal(due('2099-01-01'), null, 'decades ahead');
  assert.equal(due('2026-11-02'), '2026-11-02', 'a few days overdue is allowed');
});

test('a translated or rephrased title is refused, keeping the user\'s own words', () => {
  const title = (t: string) =>
    sanitizeExtraction({ due: '2026-11-07', title: t }, 'לשלם חשבון חשמל מחר', FRI).title;
  assert.equal(title('pay the electricity bill'), null, 'translated');
  assert.equal(title('לשלם את החשבון'), null, 'reworded');
  assert.equal(title('לשלם חשבון חשמל מחר בבוקר'), null, 'longer than the original');
  assert.equal(title(''), null);
  assert.equal(title('לשלם חשבון חשמל.'), 'לשלם חשבון חשמל.', 'punctuation is tolerated');
});

test('a Hebrew task gets its date and a clean title from Gemini', async () => {
  const signal = await withFetch(
    async () => jsonResponse(reply(JSON.stringify({
      category: 'Finance', due: '2026-11-07', title: 'לשלם חשבון חשמל',
      confidence: 0.95, reason: 'utility bill',
    }))),
    () => classifyWithGemini(
      { apiKey: 'k', model: 'm' },
      { title: 'לשלם חשבון חשמל מחר', now: FRI },
    ),
  );
  assert.equal(signal.category, 'Finance');
  assert.deepEqual(signal.extracted, { due: '2026-11-07', title: 'לשלם חשבון חשמל' });
});

test('a bare-word reply carries no extraction, rather than inventing one', () => {
  assert.equal(parseGeminiReply('Finance')?.extracted, undefined);
});

/* ---- Pick the best existing category, or create one ---- */

test('the prompt lists the user\'s categories and asks for the best fit before a new one', () => {
  const prompt = buildPrompt({ title: 'להאכיל את החתול' }, [...CATEGORIES, 'Research'], { allowNew: true });
  assert.match(prompt, /- Research: the user's own category/);
  assert.match(prompt, /pick the one that fits the\s+task best/);
  assert.match(prompt, /Only if none of them fits, create a new category/);
  assert.match(prompt, /Never create a category\s+that means the same as an existing one/);
  assert.match(prompt, /"new": <true or false>/);
  assert.match(prompt, /Inbox: LAST RESORT/);

  const closed = buildPrompt({ title: 'x' });
  assert.doesNotMatch(closed, /create a new category/, 'off unless asked for');
});

test('a new category is accepted only when it is short, clean and not a twin of an existing one', () => {
  const existing = [...CATEGORIES, 'Car'];
  assert.deepEqual(acceptNewCategory('Pets', existing), { name: 'Pets', created: true });
  assert.deepEqual(acceptNewCategory('pets', existing), { name: 'Pets', created: true }, 'Title Case');
  assert.deepEqual(acceptNewCategory('Cars', existing), { name: 'Car', created: false }, 'plural twin');
  assert.deepEqual(acceptNewCategory('errand', existing), { name: 'Errands', created: false });
  assert.deepEqual(acceptNewCategory('"Wedding".', existing), { name: 'Wedding', created: true });
  assert.deepEqual(acceptNewCategory('חתונה', existing), { name: 'חתונה', created: true });
  assert.equal(acceptNewCategory('Things To Do Around The House', existing), null, 'too many words');
  assert.equal(acceptNewCategory('A'.repeat(30), existing), null, 'too long');
  assert.equal(acceptNewCategory('Cats, dogs', existing), null, 'Notion refuses commas');
  assert.equal(acceptNewCategory('2026', existing), null, 'no letters');
  assert.equal(acceptNewCategory('', existing), null);
  assert.equal(acceptNewCategory(42, existing), null);
});

test('the reply parser creates a category only when allowed', () => {
  const created = parseGeminiReply('{"category":"Pets","new":true,"confidence":0.9}', CATEGORIES, { allowNew: true });
  assert.equal(created?.category, 'Pets');
  assert.equal(created?.created, true);

  const existing = parseGeminiReply('{"category":"finance","new":true}', CATEGORIES, { allowNew: true });
  assert.equal(existing?.category, 'Finance', 'an existing name is never "created"');
  assert.equal(existing?.created, undefined);

  assert.equal(parseGeminiReply('{"category":"Pets"}', CATEGORIES), null, 'closed list by default');
});

test('classifyWithGemini files into an existing category or reports a created one', async () => {
  const settings = { apiKey: 'k', model: 'gemini-flash' };
  const prompts: string[] = [];
  const answer = (text: string) => async (_url: unknown, init?: RequestInit) => {
    prompts.push(String(init?.body));
    return jsonResponse(reply(text));
  };

  const fresh = await withFetch(answer('{"category":"Pets","new":true,"confidence":0.8,"reason":"pet care"}'),
    () => classifyWithGemini(settings, { title: 'feed the cat' }, CATEGORIES));
  assert.equal(fresh.category, 'Pets');
  assert.equal(fresh.created, true);
  assert.match(prompts[0], /create a new category/, 'new categories are on by default');

  const known = await withFetch(answer('{"category":"Research","new":false}'),
    () => classifyWithGemini(settings, { title: 'run the assay' }, [...CATEGORIES, 'Research']));
  assert.equal(known.category, 'Research');
  assert.equal(known.created, undefined);

  await assert.rejects(
    withFetch(answer('{"category":"Pets"}'),
      () => classifyWithGemini(settings, { title: 'feed the cat' }, CATEGORIES, { allowNew: false })),
    GeminiError,
  );
});

test('review: -ies plurals, Hebrew built-in names, and no category fished from the reason', () => {
  const existing = [...CATEGORIES, 'Groceries'];
  assert.deepEqual(acceptNewCategory('Grocery', existing), { name: 'Groceries', created: false });
  assert.deepEqual(acceptNewCategory('Hobbies', [...CATEGORIES, 'Hobby']), { name: 'Hobby', created: false });
  assert.deepEqual(acceptNewCategory('עבודה', existing), { name: 'Work', created: false });
  assert.deepEqual(acceptNewCategory('בית', existing), { name: 'Home', created: false });

  const reply = '{"category":"Car Maintenance And Repair","new":true,"reason":"the car needs work"}';
  assert.equal(parseGeminiReply(reply, CATEGORIES, { allowNew: true }), null);
  assert.equal(parseGeminiReply('{"category":"Pets, Animals","title":"feed the cat before work"}', CATEGORIES, { allowNew: true }), null);
});

test('R1-12: a Gemini request that never answers times out and the rules file the task', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hang: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
  const errors: string[] = [];
  const categorizer = createGeminiCategorizer(
    { apiKey: 'k', model: 'gemini-flash' }, rulesCategorizer, (m) => errors.push(m),
  );
  const pending = withFetch(hang, () => categorizer.categorize({ title: 'pay the electricity bill' }));
  await Promise.resolve();
  t.mock.timers.tick(GEMINI_TIMEOUT_MS + 1);
  const signal = await pending;
  assert.equal(signal.source, 'rules');
  assert.equal(signal.category, 'Finance');
  assert.match(signal.fallbackReason ?? '', /took too long/);
  assert.match(errors[0], /took too long/);
});

/* ---- R1-11: Gemini's title may only cut the date words ---- */

test('R1-11: a title that reorders, drops or keeps only the date is refused', () => {
  const title = (original: string, t: string) =>
    sanitizeExtraction({ due: '2026-11-07', title: t }, original, FRI).title;
  // The report's three slips.
  assert.equal(title('להתקשר לאמא לא לאבא מחר', 'להתקשר לאבא לא לאמא'), null, 'reordered');
  assert.equal(title('לא לשלם את החשבון של דני מחר', 'לשלם את החשבון'), null, '"not" and more dropped');
  assert.equal(title('לשלם חשבון חשמל לבזק מחר', 'מחר'), null, 'only the date left');
  // Other ways to lose the meaning.
  assert.equal(title('מחר לא לשלם את החשבון', 'לשלם את החשבון'), null, 'a "not" cut with the date');
  assert.equal(title("don't call the bank tomorrow", 'call the bank'), null);
  assert.equal(title("we won't pay tomorrow", 'we pay'), null);
  assert.equal(title('לשלם חשבון חשמל מחר', 'לשלם'), null, 'over-shortened');
  assert.equal(title('לשלם חשבון חשמל מחר', 'חשבון חשמל'), null, 'a word cut away from the date');
  assert.equal(title('פגישה ביום שלישי הבא בבוקר', 'פגישה'), null, 'a one-word stub');
});

test('R1-11: a title with one short date phrase cut is used', () => {
  assert.ok(isDateCut('לשלם חשבון חשמל מחר', 'לשלם חשבון חשמל'), 'at the end');
  assert.ok(isDateCut('מחר לשלם חשבון חשמל', 'לשלם חשבון חשמל'), 'at the start');
  assert.ok(isDateCut('להתקשר ביום שלישי לאמא', 'להתקשר לאמא'), 'in the middle');
  assert.ok(isDateCut('להתקשר לאמא ביום שלישי הבא', 'להתקשר לאמא'), 'three date words, two kept');
  assert.ok(isDateCut('פגישה עם יוסי עד יום חמישי הבא', 'פגישה עם יוסי'), 'four date words');
  assert.ok(isDateCut('ישיבה ביום ראשון', 'ישיבה'), 'a short task keeps one word');
  assert.ok(isDateCut('להגיש דו"ח הוצאות מחר', 'להגיש דו"ח הוצאות'), 'Hebrew acronyms');
  assert.ok(isDateCut('לשלם חשבון חשמל מחר', 'לשלם חשבון חשמל.'), 'punctuation is tolerated');
  assert.ok(!isDateCut('a b c d e f g h', 'a b c'), 'five words is not a date phrase');
});

test('R1-11: end to end, a slip keeps the user\'s words and still takes the date', async () => {
  const categorizer = createGeminiCategorizer({ apiKey: 'k', model: 'm' }, rulesCategorizer);
  const { draft } = await withFetch(
    async () => jsonResponse(reply(JSON.stringify({
      category: 'Finance', due: '2026-11-07', title: 'מחר', confidence: 0.9, reason: 'bill',
    }))),
    () => captureDraft('לשלם חשבון חשמל לבזק מחר', FRI, categorizer),
  );
  assert.equal(draft.title, 'לשלם חשבון חשמל לבזק מחר');
  assert.equal(draft.due, '2026-11-07');
});

/* ---- R1-13: a broken reply never takes its category from free text ---- */

test('R1-13: a Hebrew acronym with a plain quote no longer breaks the reply', () => {
  const text = '{"category":"Work","due":"2026-11-07","title":"להגיש דו"ח הוצאות","reason":"expense report for work, finance related"}';
  const signal = parseGeminiReply(text);
  assert.equal(signal?.category, 'Work', 'the category field, not "finance" in the reason');
  assert.deepEqual(signal?.extracted, { due: '2026-11-07', title: 'להגיש דו"ח הוצאות' });
  assert.equal(
    sanitizeExtraction(signal?.extracted, 'להגיש דו"ח הוצאות מחר', FRI).title,
    'להגיש דו"ח הוצאות',
  );
});

test('R1-13: JSON broken some other way still gives its own category and date', () => {
  const text = '{"category":"Work","due":"2026-11-07","title":"send the "final" deck","reason":"for personal use"}';
  const signal = parseGeminiReply(text);
  assert.equal(signal?.category, 'Work');
  assert.equal(signal?.extracted?.due, '2026-11-07');
  assert.equal(signal?.extracted?.title, null, 'a field that cannot be read safely is left out');
});

test('R1-13: a JSON reply without a usable category is refused, not word-searched', () => {
  assert.equal(parseGeminiReply('{"category":"Shopping","reason":"personal shopping for a gift"}'), null);
  assert.equal(parseGeminiReply('{"reason":"not Work related"}'), null, 'no category field');
  assert.equal(parseGeminiReply('{"category":null,"title":"pay the bill for work"}'), null);
  assert.equal(parseGeminiReply('{"reason":"for work and finance", "category": "Fin'), null,
    'cut off inside the category: none, whatever the reason says');
  assert.equal(parseGeminiReply('{"category":"Work","due":"2026-11-07"')?.category, 'Work',
    'cut off, but the category itself was complete');
});

test('R1-13: a bare reply must be short and name one category', () => {
  assert.equal(parseGeminiReply('Finance or Home'), null, 'two categories is no answer');
  assert.equal(
    parseGeminiReply('This one is hard to say, it could be about money but it mentions Work'),
    null,
    'a long sentence is not a category',
  );
});

test('R1-13: end to end, the report\'s reply files under Work with its date', async () => {
  const categorizer = createGeminiCategorizer({ apiKey: 'k', model: 'm' }, rulesCategorizer);
  const { draft, signal } = await withFetch(
    async () => jsonResponse(reply(
      '{"category":"Work","due":"2026-11-07","title":"להגיש דו"ח הוצאות","reason":"expense report for work, finance related"}',
    )),
    () => captureDraft('להגיש דו"ח הוצאות מחר', FRI, categorizer),
  );
  assert.equal(signal.source, 'gemini');
  assert.equal(draft.category, 'Work');
  assert.equal(draft.due, '2026-11-07');
  assert.equal(draft.title, 'להגיש דו"ח הוצאות');
});

test('R1-13: Gemini is asked for JSON, and a model without JSON mode is asked again plainly', async () => {
  const bodies: string[] = [];
  const signal = await withFetch(async (_url, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) {
      return jsonResponse({
        error: { code: 400, status: 'INVALID_ARGUMENT', message: 'JSON mode is not enabled for models/gemma-3-27b-it' },
      }, 400);
    }
    return jsonResponse(reply('{"category":"Home"}'));
  }, () => classifyWithGemini({ apiKey: 'k', model: 'gemma-3-27b-it' }, { title: 'fix the door' }));

  assert.equal(JSON.parse(bodies[0]).generationConfig.responseMimeType, 'application/json');
  assert.equal(bodies.length, 2);
  assert.ok(!bodies[1].includes('responseMimeType'), 'the retry drops it');
  assert.equal(signal.category, 'Home');
});

test('R1-13: a key or quota error is not retried as if an option were at fault', async () => {
  let calls = 0;
  await assert.rejects(
    withFetch(async () => {
      calls += 1;
      return jsonResponse({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } }, 429);
    }, () => classifyWithGemini({ apiKey: 'k', model: 'm' }, { title: 'x' })),
    GeminiError,
  );
  assert.equal(calls, 1);
});

/* ---- R1-41: rate limits say which limit it was ---- */

const quota = (quotaId: string, quotaValue: string, retryDelay?: string) => ({
  error: {
    code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue }] },
      ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
    ],
  },
});

test('R1-41: a used-up daily quota says it lasts until the reset, not "shortly"', () => {
  const message = describeGeminiError(
    quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '50', '40s'), 429,
  );
  assert.match(message, /daily Gemini limit/);
  assert.match(message, /within a day/);
  assert.doesNotMatch(message, /shortly|40 seconds/);
});

test('R1-41: a model with no free quota says to pick another', () => {
  const message = describeGeminiError(
    quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '0'), 429,
  );
  assert.match(message, /no free quota/);
  assert.match(message, /Pick another in AI settings/);
  assert.match(
    describeGeminiError({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: x, limit: 0, model: y' } }, 429),
    /no free quota/,
  );
});

test('R1-41: a per-minute limit uses the wait Google sends', () => {
  const minute = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier';
  assert.match(describeGeminiError(quota(minute, '15', '17.4s'), 429), /Try again in 18 seconds/);
  assert.match(describeGeminiError(quota(minute, '15', '1s'), 429), /in 1 second\./);
  assert.match(describeGeminiError(quota(minute, '15', '130s'), 429), /in 3 minutes/);
  assert.match(describeGeminiError(quota(minute, '15'), 429), /work again shortly/);
});

/* ---- R1-24: a website restriction that blocks the app is named ---- */

test('R1-24: a key restricted to the wrong website address is not called unusable', () => {
  const blocked = {
    error: {
      code: 403, status: 'PERMISSION_DENIED',
      message: 'Requests from referer https://itaigree.github.io/ are blocked.',
      details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }],
    },
  };
  const message = describeGeminiError(blocked, 403);
  assert.match(message, /website restriction blocks this site/);
  assert.match(message, /address followed by \/\*/);
  assert.match(describeGeminiError({ error: { status: 'PERMISSION_DENIED' } }, 403), /cannot use the Gemini API/);
});

/* ---- R1-43: with AI on, a tag naming a category wins too ---- */

test('R1-43: a tag naming a category wins over Gemini, which still finds the date', async () => {
  const signal = await withFetch(
    async () => jsonResponse(reply(JSON.stringify({
      category: 'Finance', due: '2026-11-07', title: 'לשלם חשבון חשמל', reason: 'a bill',
    }))),
    () => classifyWithGemini(
      { apiKey: 'k', model: 'm' },
      { title: 'לשלם חשבון חשמל מחר', tags: ['home'], now: FRI },
      CATEGORIES,
    ),
  );
  assert.equal(signal.category, 'Home');
  assert.equal(signal.reason, 'named by a tag');
  assert.equal(signal.source, 'gemini');
  assert.deepEqual(signal.extracted, { due: '2026-11-07', title: 'לשלם חשבון חשמל' });
});

test('R1-43: a tag can name the user\'s own category, and a category Gemini made is dropped', async () => {
  const signal = await withFetch(
    async () => jsonResponse(reply('{"category":"Paperwork","new":true}')),
    () => classifyWithGemini({ apiKey: 'k', model: 'm' }, { title: 'IRB renewal form', tags: ['research'] },
      [...CATEGORIES, 'Research']),
  );
  assert.equal(signal.category, 'Research');
  assert.equal(signal.created, undefined, 'nothing new is remembered');
});

test('R2-9: when Gemini fails, the rules still honour a tag naming the user\'s own category', async () => {
  const categorizer = createGeminiCategorizer(
    { apiKey: 'k', model: 'm' }, rulesCategorizer, undefined, () => [...CATEGORIES, 'Research'],
  );
  const signal = await withFetch(
    async () => { throw new Error('offline'); },
    () => categorizer.categorize({ title: 'IRB renewal form', tags: ['research'] }),
  );
  assert.equal(signal.source, 'rules');
  assert.equal(signal.category, 'Research');
});

/* ---- R1-23: a retired saved model is shown as such ---- */

test('R1-23: a saved model Google no longer lists stays selectable as "unavailable"', () => {
  const models = [{ id: 'gemini-2.5-flash-lite', label: 'Lite' }, { id: 'gemini-2.5-flash', label: 'Flash' }];
  const retired = modelChoices(models, 'gemini-2.0-flash-lite');
  assert.equal(retired[0].id, 'gemini-2.0-flash-lite', 'first, so the dropdown shows what is in use');
  assert.equal(retired[0].unavailable, true);
  assert.match(retired[0].label, /unavailable/);
  assert.deepEqual(retired.slice(1), models, 'every listed model is a real change from it');

  assert.deepEqual(modelChoices(models, 'gemini-2.5-flash'), models);
  assert.deepEqual(modelChoices([], 'gemini-2.5-flash'), [{ id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' }],
    'before the list is read, just the current one');
});
