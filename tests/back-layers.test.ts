import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackLayers } from '../src/lib/back-layers.ts';

/**
 * A session history that behaves like Chrome's: `back()` from the page lands
 * later (its popstate comes after), on the entry before the one that was
 * current when it was called; the back gesture is the user's and immediate.
 */
function fakeBrowser() {
  const entries: unknown[] = ['page'];
  let index = 0;
  const queued: Array<() => void> = [];
  let onPop = () => {};
  const goTo = (target: number) => {
    if (target < 0) return 'left the app';
    index = target;
    onPop();
    return 'stayed';
  };
  const history = {
    get state() {
      return entries[index];
    },
    pushState(data: unknown) {
      entries.splice(index + 1);
      entries.push(data);
      index += 1;
    },
    back() {
      const target = index - 1;
      queued.push(() => goTo(target));
    },
  };
  const layers = createBackLayers(history);
  onPop = () => layers.popped();
  return {
    layers,
    /** How many entries sit above the page itself. */
    depth: () => index,
    /** The Android back gesture. */
    gesture: () => goTo(index - 1),
    /** Let the page's own back() calls land. */
    settle() {
      while (queued.length) queued.shift()!();
    },
  };
}

test('back closes an open sheet instead of leaving the app', () => {
  const b = fakeBrowser();
  let closed = 0;
  const release = b.layers.open(() => closed++);
  assert.equal(b.depth(), 1, 'opening adds one history entry');

  assert.equal(b.gesture(), 'stayed');
  assert.equal(closed, 1, 'the sheet was told to close');
  release(); // the sheet unmounts after closing
  b.settle();
  assert.equal(b.depth(), 0, 'its entry was used up by the back, and no second step was taken');
  assert.equal(b.gesture(), 'left the app', 'the next back leaves, as it would with nothing open');
});

test('closing with a button takes the entry back out, closing nothing else', () => {
  const b = fakeBrowser();
  let closed = 0;
  const release = b.layers.open(() => closed++);
  release();
  b.settle();
  assert.equal(b.depth(), 0, 'no dangling entry needing an extra back');
  assert.equal(closed, 0, 'the popstate from that step is not mistaken for the user going back');
  assert.equal(b.gesture(), 'left the app');
});

test('reopening before the earlier step back has landed keeps the new sheet open', () => {
  // Also what React's development mode does to every overlay: open, close, open.
  const b = fakeBrowser();
  const release = b.layers.open(() => assert.fail('the first sheet is already closed'));
  release(); // its back() is still on its way…
  let closed = 0;
  const releaseAgain = b.layers.open(() => closed++); // …when it opens again
  b.settle();
  assert.equal(closed, 0, 'the late popstate does not close the new sheet');
  assert.equal(b.depth(), 1, 'and the new sheet has its entry once the step back has landed');
  assert.equal(b.gesture(), 'stayed');
  assert.equal(closed, 1, 'so back closes it');
  releaseAgain();
  b.settle();
  assert.equal(b.gesture(), 'left the app');
});

test('closing a reopened sheet before its entry was added steps back only once', () => {
  const b = fakeBrowser();
  b.layers.open(() => {})();
  const release = b.layers.open(() => assert.fail('closed by its button, not by back'));
  release(); // closed before the first step back landed
  b.settle();
  assert.equal(b.depth(), 0);
  assert.equal(b.gesture(), 'left the app', 'the page entry itself was not stepped over');
});

test('with two layers open, back closes only the top one', () => {
  const b = fakeBrowser();
  const closed: string[] = [];
  const releaseSettings = b.layers.open(() => closed.push('settings'));
  const releaseSheet = b.layers.open(() => closed.push('sheet'));
  b.gesture();
  assert.deepEqual(closed, ['sheet']);
  releaseSheet();
  b.gesture();
  assert.deepEqual(closed, ['sheet', 'settings']);
  releaseSettings();
  b.settle();
  assert.equal(b.depth(), 0);
});

test('releasing twice steps back once', () => {
  const b = fakeBrowser();
  const release = b.layers.open(() => {});
  release();
  release();
  b.settle();
  assert.equal(b.depth(), 0);
  assert.equal(b.gesture(), 'left the app', 'the page entry itself was not stepped over');
});

test('a popstate with nothing open is left to the browser', () => {
  const b = fakeBrowser();
  assert.doesNotThrow(() => b.layers.popped());
});
