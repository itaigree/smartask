import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetDeviceSettings, forgetQuestion, leftBehind } from '../src/lib/forget.ts';
import { loadGeminiConfig } from '../src/lib/config.ts';
import { loadCustomCategories } from '../src/lib/categories.ts';
import { readTasks, TASKS_KEY } from '../src/lib/local-store.ts';

/** A browser with one person's things saved, for the length of `body`. */
function withDevice(body: (data: Map<string, string>) => void) {
  const data = new Map<string, string>([
    ['smartask.gemini.v1', JSON.stringify({ apiKey: 'AIzaFirstPersonsKey000', model: 'gemini-2.5-flash' })],
    ['smartask.categories.v1', JSON.stringify(['Divorce lawyer', 'IVF clinic'])],
    [TASKS_KEY, JSON.stringify({ version: 1, tasks: [{ id: 'a', title: 'call the clinic' }] })],
    ['smartask.speechLang', 'he-IL'],
  ]);
  const g = globalThis as { window?: unknown };
  g.window = {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v); },
      removeItem: (k: string) => { data.delete(k); },
    },
  };
  try {
    body(data);
  } finally {
    delete g.window;
  }
}

test('R1-14: after ⏻ the Gemini key and the category names are offered for forgetting', () => {
  withDevice(() => {
    const left = leftBehind();
    assert.deepEqual(left, { geminiKey: true, customCategories: 2 });
    const question = forgetQuestion(left) ?? '';
    assert.match(question, /the Gemini key and your 2 custom categories/);
    assert.match(question, /shared device/);
    assert.doesNotMatch(question, /phone-only/, 'nothing about tasks when leaving Notion');
  });
});

test('R1-14: forgetting clears the key and the names, and never a task', () => {
  withDevice((data) => {
    forgetDeviceSettings();
    assert.equal(loadGeminiConfig(), null);
    assert.equal(data.has('smartask.gemini.v1'), false, 'the key is gone from storage');
    assert.deepEqual(loadCustomCategories(), []);
    assert.doesNotMatch(data.get('smartask.categories.v1') ?? '', /Divorce|IVF/);

    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: () => {} };
    assert.deepEqual(readTasks(store).map((t) => t.title), ['call the clinic'], 'phone-only tasks stay');
    assert.deepEqual(leftBehind(), { geminiKey: false, customCategories: 0 });
    assert.equal(forgetQuestion(leftBehind()), null, 'nothing left: no second question');
  });
});

test('R1-14: the question names only what is there, and says phone-only tasks stay', () => {
  assert.equal(forgetQuestion({ geminiKey: false, customCategories: 0 }), null);
  assert.match(forgetQuestion({ geminiKey: true, customCategories: 0 }) ?? '', /forget the Gemini key on/);
  assert.match(forgetQuestion({ geminiKey: false, customCategories: 1 }) ?? '', /your custom category on/);
  assert.match(
    forgetQuestion({ geminiKey: true, customCategories: 3 }, true) ?? '',
    /Your phone-only tasks stay either way/,
  );
});

test('R1-14: with no browser storage there is nothing to forget, and no crash', () => {
  assert.deepEqual(leftBehind(), { geminiKey: false, customCategories: 0 });
  forgetDeviceSettings();
});
