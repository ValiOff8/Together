import { test } from 'node:test';
import assert from 'node:assert/strict';
import { difference, applyOperation, transformOperations, rebaseDraft, acknowledgeDraft } from '../src/web/text-operations.js';

test('text edits preserve whitespace, newlines, Unicode, and empty sheets', () => {
  for (const before of ['', 'Hello world', '  ä😀\nsecond line\n']) {
    for (const after of ['', before, '  New 📝 text\n\n ']) assert.equal(applyOperation(before, difference(before, after)), after);
  }
  assert.throws(() => applyOperation('text', [3]), /version/);
  for (const operation of [[null], [0], [1.5], [100001], ['x'.repeat(100001)]]) assert.throws(() => applyOperation('', operation));
});

test('all overlapping inserts, replacements, and deletes converge without deleting concurrent inserts', () => {
  const base = 'abcd', operations = [];
  for (let start = 0; start <= base.length; start++) {
    for (let end = start; end <= base.length; end++) {
      for (const insert of ['', 'X', 'YZ']) operations.push(difference(base, base.slice(0, start) + insert + base.slice(end)));
    }
  }
  for (const local of operations) for (const remote of operations) {
    const [a, b] = transformOperations(local, remote);
    assert.equal(applyOperation(applyOperation(base, remote), a), applyOperation(applyOperation(base, local), b));
  }
  const [remove] = transformOperations(difference('abc', ''), difference('abc', 'aNEWbc'));
  assert.equal(applyOperation('aNEWbc', remove), 'NEW');
});

test('drafts rebase and typing during an outstanding save survives acknowledgments and later changes', () => {
  const base = 'hello';
  const sent = { id: 'mine', operation: difference(base, 'hello!'), content: 'hello!' };
  const remote = difference(base, 'Hello');
  const [mine] = transformOperations(sent.operation, remote);
  const accepted = applyOperation('Hello', mine);
  const later = difference(accepted, 'Hello! Friend');
  const changes = [
    { operation_id: 'friend', operation: remote },
    { operation_id: 'mine', operation: mine },
    { operation_id: 'later', operation: later },
  ];
  const pending = acknowledgeDraft(sent, 'hello! More', changes);
  assert.equal(applyOperation('Hello! Friend', pending), 'Hello! Friend More');
  assert.equal(applyOperation('Hello', rebaseDraft(base, 'hello!', changes.slice(0, 1))), 'Hello!');
  assert.throws(() => acknowledgeDraft(sent, 'hello!', []), /confirmed/);
});
