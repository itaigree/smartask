import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, toISODate, addDays, addMonths, localDateOf } from '../src/lib/parse.ts';

/** Wednesday 2026-11-04, so weekday maths is deterministic. */
const NOW = new Date(2026, 10, 4, 9, 0, 0);
const iso = (days: number) => toISODate(addDays(NOW, days));

test('plain text with no tokens becomes a Normal, undated task', () => {
  const d = parseTask('write the quarterly summary', NOW);
  assert.equal(d.title, 'write the quarterly summary');
  assert.equal(d.due, null);
  assert.equal(d.priority, 'Normal');
  assert.equal(d.project, null);
  assert.deepEqual(d.tags, []);
  assert.equal(d.note, null);
});

test('the PLAN.md acceptance case', () => {
  const d = parseTask('pay rent friday !! #home @bills', NOW);
  assert.equal(d.title, 'pay rent');
  assert.equal(d.due, iso(2)); // Wed -> Fri
  assert.equal(d.priority, 'Urgent');
  assert.equal(d.project, 'home');
  assert.deepEqual(d.tags, ['bills']);
});

test('relative dates', () => {
  assert.equal(parseTask('x today', NOW).due, iso(0));
  assert.equal(parseTask('x tomorrow', NOW).due, iso(1));
  assert.equal(parseTask('x day after tomorrow', NOW).due, iso(2));
  assert.equal(parseTask('x in 3 days', NOW).due, iso(3));
  assert.equal(parseTask('x in 2 weeks', NOW).due, iso(14));
  assert.equal(parseTask('x next week', NOW).due, iso(7));
});

test('weekday names resolve to the next occurrence, today included', () => {
  assert.equal(parseTask('x wednesday', NOW).due, iso(0), 'today is Wednesday');
  assert.equal(parseTask('x on monday', NOW).due, iso(5));
  assert.equal(parseTask('x next monday', NOW).due, iso(12));
});

test('explicit date formats', () => {
  assert.equal(parseTask('x 2026-12-25', NOW).due, '2026-12-25');
  assert.equal(parseTask('x 25/12', NOW).due, '2026-12-25');
  assert.equal(parseTask('x dec 25', NOW).due, '2026-12-25');
  assert.equal(parseTask('x 25 dec', NOW).due, '2026-12-25');
});

test('a bare day/month that already passed rolls to next year', () => {
  assert.equal(parseTask('x 3/1', NOW).due, '2027-01-03');
});

test('priority notation', () => {
  assert.equal(parseTask('x !', NOW).priority, 'High');
  assert.equal(parseTask('x !!', NOW).priority, 'Urgent');
  assert.equal(parseTask('fix this asap', NOW).priority, 'Urgent');
  assert.equal(parseTask('read it someday', NOW).priority, 'Low');
});

test('bang notation is stripped from the title', () => {
  assert.equal(parseTask('ship the release !!', NOW).title, 'ship the release');
});

test('multiple tags, de-duplicated, last project wins', () => {
  const d = parseTask('plan trip @travel @budget @travel #q4 #holiday', NOW);
  assert.deepEqual(d.tags, ['travel', 'budget']);
  assert.equal(d.project, 'holiday');
  assert.equal(d.title, 'plan trip');
});

test('text after a newline or " // " becomes the note', () => {
  assert.equal(parseTask('call plumber\nring the side door', NOW).note, 'ring the side door');
  assert.equal(parseTask('call plumber // ring the side door', NOW).note, 'ring the side door');
});

test('a date phrase does not leave dangling filler in the title', () => {
  assert.equal(parseTask('call the bank about the overdraft tomorrow', NOW).title,
    'call the bank about the overdraft');
  assert.equal(parseTask('send invoice by friday', NOW).title, 'send invoice');
});

test('tokens are never mistaken for dates', () => {
  assert.equal(parseTask('review notes #dec', NOW).due, null);
  assert.equal(parseTask('review notes @monday', NOW).due, null);
});

test('an empty-ish input still yields a title', () => {
  assert.equal(parseTask('tomorrow', NOW).title, 'tomorrow');
});

/* ---- Bug-hunt regressions (docs/bug-hunt-2026-11-06.md) ---- */

test('R1-1: tokens before a date no longer shift the cut and corrupt the title', () => {
  const cases: Array<[string, string, string]> = [
    ['#home pay rent friday', 'pay rent', iso(2)],
    ['!! call the bank tomorrow', 'call the bank', iso(1)],
    ['urgent call bank tomorrow', 'call bank', iso(1)],
    ['call mom @family tomorrow', 'call mom', iso(1)],
    ['#home @bills pay rent next monday', 'pay rent', iso(12)],
    ['#בית לשלם חשבון 25/12', 'לשלם חשבון', '2026-12-25'],
    ['!! לשלם ארנונה 15/11', 'לשלם ארנונה', '2026-11-15'],
  ];
  for (const [input, title, due] of cases) {
    const d = parseTask(input, NOW);
    assert.equal(d.title, title, input);
    assert.equal(d.due, due, input);
  }
});

test('R1-10: a priority word written as a tag or project sets priority without eating text', () => {
  const a = parseTask('call bank @urgent tomorrow', NOW);
  assert.equal(a.title, 'call bank');
  assert.equal(a.due, iso(1));
  assert.equal(a.priority, 'Urgent');
  assert.deepEqual(a.tags, ['urgent']);
  assert.equal(parseTask('call bank #asap please', NOW).title, 'call bank please');
  assert.equal(parseTask('fix the sink @important tomorrow', NOW).priority, 'High');
});

test('R1-19: links and possessives are left alone', () => {
  for (const input of [
    'read https://news.com/today/article',
    'read https://site.com/2024/12/01/post',
    'read https://site.com/urgent-care-tips',
    'לקרוא https://www.haaretz.co.il/news/politics/2026-11-05/ty-article/x',
  ]) {
    const d = parseTask(input, NOW);
    assert.equal(d.title, input);
    assert.equal(d.due, null, input);
    assert.equal(d.priority, 'Normal', input);
  }
  const possessive = parseTask("review today's agenda", NOW);
  assert.equal(possessive.title, "review today's agenda");
  assert.equal(possessive.due, null);
});

test('R1-4: quantities, versions, prices and times are not dates', () => {
  for (const input of [
    'לקנות 1.5 ליטר חלב', 'buy 3.5 liters milk', 'upgrade python 3.12', 'pay 5.10 for parking',
    'buy 1/2 kg cheese', 'install node 22.11', 'meeting at 9.05', 'בשעה 9.30 פגישה',
  ]) {
    const d = parseTask(input, NOW);
    assert.equal(d.due, null, input);
    assert.equal(d.title, input, input);
  }
  const both = parseTask('meeting at 9.05 tomorrow', NOW);
  assert.equal(both.due, iso(1), '"tomorrow" beats a time');
  assert.equal(both.title, 'meeting at 9.05');
});

test('R1-9: a real date later in the text is still found', () => {
  const cases: Array<[string, string, string]> = [
    ['buy 2 eggs dec 25', 'buy 2 eggs', '2026-12-25'],
    ['call 3 clients on dec 5', 'call 3 clients', '2026-12-05'],
    ['buy 6 eggs 25 dec', 'buy 6 eggs', '2026-12-25'],
    ['book table for 4 on may 12', 'book table for 4', '2027-05-12'],
    ['pay 12.50 to dan by 25/12', 'pay 12.50 to dan', '2026-12-25'],
    ['dentist at 8.30 on 25/12', 'dentist at 8.30', '2026-12-25'],
  ];
  for (const [input, title, due] of cases) {
    const d = parseTask(input, NOW);
    assert.equal(d.title, title, input);
    assert.equal(d.due, due, input);
  }
});

test('R1-20: a year after a month name is honoured', () => {
  const a = parseTask('renew passport by 3 march 2028', NOW);
  assert.equal(a.due, '2028-03-03');
  assert.equal(a.title, 'renew passport');
  assert.equal(parseTask('x dec 25 2027', NOW).due, '2027-12-25');
  assert.equal(parseTask('x december 25th, 2027', NOW).due, '2027-12-25');
});

test('R1-21: impossible dates are rejected instead of rolling over', () => {
  for (const input of ['pay rent 31/02', 'x 2026-02-31', 'x 2026-13-45', 'x 25/12/202', 'x 31.04.2027']) {
    const d = parseTask(input, NOW);
    assert.equal(d.due, null, input);
    assert.equal(d.title, input, 'the text stays in the title');
  }
  assert.equal(parseTask('x 29/02', NOW).due, '2028-02-29', 'the next real 29 February');
  assert.equal(parseTask('x 29/02', new Date(2027, 10, 6)).due, '2028-02-29');
  assert.equal(parseTask('x 25/12/26', NOW).due, '2026-12-25');
});

test('R1-22: adding months clamps to the end of a shorter month', () => {
  assert.equal(toISODate(addMonths(new Date(2026, 0, 31), 1)), '2026-02-28');
  assert.equal(toISODate(addMonths(new Date(2026, 4, 31), 1)), '2026-06-30');
  assert.equal(toISODate(addMonths(new Date(2027, 2, 31), 3)), '2027-06-30');
  assert.equal(parseTask('x next month', new Date(2026, 0, 31)).due, '2026-02-28');
  assert.equal(parseTask('x in 3 months', new Date(2027, 2, 31)).due, '2027-06-30');
});

test('R1-17/R1-18/R1-45: priority words in any case, only as markers, negation, now! and !!!!', () => {
  const cases: Array<[string, string, string]> = [
    ['Urgent call the bank', 'call the bank', 'Urgent'],
    ['ASAP fix the sink', 'fix the sink', 'Urgent'],
    ['Call the bank ASAP', 'Call the bank', 'Urgent'],
    ['URGENT: fix the server', 'fix the server', 'Urgent'],
    ['Important: renew insurance', 'renew insurance', 'High'],
    ['call the plumber, not urgent', 'call the plumber', 'Low'],
    ['not important, read later', 'read later', 'Low'],
    ['buy emergency kit', 'buy emergency kit', 'Normal'],
    ['file important documents', 'file important documents', 'Normal'],
    ['groom the backlog', 'groom the backlog', 'Normal'],
    ['call me as soon as possible', 'call me', 'Urgent'],
    ['call bank now!', 'call bank', 'Urgent'],
    ['x !!!!', 'x', 'Urgent'],
    ['clean the garage eventually', 'clean the garage', 'Low'],
  ];
  for (const [input, title, priority] of cases) {
    const d = parseTask(input, NOW);
    assert.equal(d.title, title, input);
    assert.equal(d.priority, priority, input);
  }
});

test('R1-44: a title that merely ends in on/by/at keeps it', () => {
  for (const input of ['turn the heating on', 'put the kettle on', 'ask dan to stop by', 'follow up on']) {
    assert.equal(parseTask(input, NOW).title, input);
  }
  assert.equal(parseTask('call bank by 10/11', NOW).title, 'call bank', 'but leaves with a date');
});

test('R2-2: a Hebrew preposition before a date leaves with it', () => {
  const cases: Array<[string, string, string]> = [
    ['לשלם ארנונה עד 10/11', 'לשלם ארנונה', '2026-11-10'],
    ['לשלם ארנונה ב-10/11', 'לשלם ארנונה', '2026-11-10'],
    ['פגישה עם יוסי ב10.11', 'פגישה עם יוסי', '2026-11-10'],
    ['לשלם ארנונה עד ה-15/11 #בית', 'לשלם ארנונה', '2026-11-15'],
    ['מבחן ב 20/11 !!', 'מבחן', '2026-11-20'],
    ['פגישה עם רופא ב-10.11 בשעה 9', 'פגישה עם רופא בשעה 9', '2026-11-10'],
    ['פגישה 25.12', 'פגישה', '2026-12-25'],
  ];
  for (const [input, title, due] of cases) {
    const d = parseTask(input, NOW);
    assert.equal(d.title, title, input);
    assert.equal(d.due, due, input);
  }
});

test('R2-10: Hebrew acronyms typed with a plain quote stay whole', () => {
  const a = parseTask('משימה #ביה"ס', NOW);
  assert.equal(a.project, 'ביה"ס');
  assert.equal(a.title, 'משימה');
  const b = parseTask('להתקשר @עו"ד', NOW);
  assert.deepEqual(b.tags, ['עו"ד']);
  assert.equal(b.title, 'להתקשר');
  assert.deepEqual(parseTask("call @dan's office", NOW).tags, ['dan'], 'English possessive unchanged');
});

test('localDateOf turns a Notion timestamp into the local day', () => {
  assert.equal(localDateOf('2026-11-06'), '2026-11-06');
  assert.equal(localDateOf('2026-02-31'), null);
  assert.equal(localDateOf('not a date'), null);
  assert.equal(localDateOf(null), null);
  const stamp = '2026-11-06T14:00:00.000+02:00';
  assert.equal(localDateOf(stamp), toISODate(new Date(stamp)));
});
