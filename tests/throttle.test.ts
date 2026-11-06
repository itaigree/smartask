import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle } from '../src/lib/throttle.ts';

test('the first call goes through, repeats inside the window do not', () => {
  let t = 1_000;
  const allow = createThrottle(10_000, () => t);
  assert.equal(allow(), true);
  t += 500;
  assert.equal(allow(), false, 'a burst of focus events collapses to one refresh');
  t += 9_000;
  assert.equal(allow(), false);
  t += 600; // now 10.1s after the first
  assert.equal(allow(), true);
});

test('a blocked call does not push the window back', () => {
  let t = 0;
  const allow = createThrottle(10_000, () => t);
  allow();
  t = 9_999;
  allow(); // blocked — must not reset the timer
  t = 10_000;
  assert.equal(allow(), true);
});
