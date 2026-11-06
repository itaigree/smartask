import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrompt, parseGeminiReply, extractText, describeGeminiError,
  scoreModel, pickDefaultModel, listGeminiModels, createGeminiCategorizer,
  classifyWithGemini, GeminiError,
} from '../src/lib/categorize/gemini.ts';
import { rulesCategorizer } from '../src/lib/categorize/rules.ts';
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
  assert.deepEqual(signal, { category: 'Finance', confidence: 0.9, reason: 'a bill' });
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
