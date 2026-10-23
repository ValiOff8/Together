import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/app.mjs';
import { difference } from '../src/web/text-operations.js';

async function start(database = ':memory:', appUrl = '') {
  const app = await createApp({ database, appUrl });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  function client() {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async request(path, input, extra = {}) {
        const response = await fetch(origin + path, {
          ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }),
          headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...(cookie ? { Cookie: cookie } : {}), ...extra },
        });
        if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        return { status: response.status, data: await response.json(), headers: response.headers };
      },
      async action(input) { return this.request('/api/action', input); },
      async state() { const r = await this.request('/api/state'); assert.equal(r.status, 200); return r.data; },
    };
  }
  return { app, origin, client };
}
const ownerCredentials = { name: 'Alex Owner', email: 'alex@example.com', password: 'owner password 123' };
const memberCredentials = { name: 'Sam Friend', email: 'sam@example.com', password: 'member password 123' };

async function inviteMember(owner, member, credentials = memberCredentials) {
  const invitation = await owner.action({ action: 'invite', email: credentials.email });
  assert.equal(invitation.status, 200);
  const invite = new URL('http://test' + invitation.data.invitePath).searchParams.get('invite');
  assert.equal((await member.request('/api/register', { ...credentials, invite })).status, 201);
  return (await member.state()).me.id;
}

test('private lists enforce grants on every task and sheet mutation, including revocation', async t => {
  const { app, client } = await start(); t.after(() => app.close());
  const owner = client(), member = client(), other = client();
  await owner.request('/api/setup', ownerCredentials);
  const memberId = await inviteMember(owner, member);
  const listId = (await owner.state()).lists[0].id;
  await owner.action({ action: 'add-task', listId, text: 'Secret task', note: '' });
  const task = (await owner.state()).tasks[0];
  const sheetId = (await owner.action({ action: 'add-sheet', listId, title: 'Secret sheet' })).data.sheetId;
  await owner.request('/api/sheet', { sheetId, version: 0, operationId: 'secret', operation: ['Secret text'] });
  const mutations = [
    { action: 'rename-list', listId, title: 'Renamed' },
    { action: 'delete-list', listId },
    { action: 'add-task', listId, text: 'New task' },
    { action: 'update-task', taskId: task.id, version: task.version, text: 'Changed' },
    { action: 'delete-task', taskId: task.id, version: task.version },
    { action: 'complete-list', listId },
    { action: 'delete-completed-tasks', listId },
    { action: 'add-sheet', listId, title: 'New sheet' },
    { action: 'rename-sheet', sheetId, title: 'Renamed' },
    { action: 'delete-sheet', sheetId, version: 1 },
    { action: 'update-sheet', sheetId, version: 1, operationId: 'denied-action', operation: [11, '!'] },
    { action: 'share-list', listId, userId: memberId, permission: 'edit' },
  ];
  const checkDenied = async status => {
    for (const mutation of mutations) assert.equal((await member.action(mutation)).status, status, mutation.action);
    assert.equal((await member.request('/api/sheet', { sheetId, version: 1, operationId: 'denied-sheet', operation: [11, '!'] })).status, status);
    // Permissions are checked before stale versions or idempotent retries expose data.
    assert.equal((await member.request('/api/sheet', { sheetId, version: 0, operationId: 'secret', operation: ['Secret text'] })).status, status);
  };
  let state = await member.state();
  assert.deepEqual([state.lists, state.tasks, state.sheets], [[], [], []]);
  await checkDenied(404);
  assert.equal((await owner.action({ action: 'share-list', listId, userId: memberId, permission: 'read' })).status, 200);
  state = await member.state();
  assert.equal(state.lists[0].permission, 'read');
  assert.deepEqual(state.lists[0].grants, []);
  assert.equal(state.tasks[0].text, 'Secret task');
  assert.equal(state.sheets[0].content, 'Secret text');
  await checkDenied(403);
  await owner.action({ action: 'share-list', listId, userId: memberId, permission: 'edit' });
  assert.equal((await member.action({ action: 'rename-list', listId, title: 'Editor renamed' })).status, 200);
  assert.equal((await member.action({ action: 'update-task', taskId: task.id, version: 1, done: true })).status, 200);
  assert.equal((await member.request('/api/sheet', { sheetId, version: 1, operationId: 'allowed', operation: [11, '!'] })).status, 200);
  assert.equal((await member.action({ action: 'delete-list', listId })).status, 403);
  assert.equal((await member.action({ action: 'share-list', listId, userId: memberId, permission: 'none' })).status, 403);
  await owner.action({ action: 'share-list', listId, userId: memberId, permission: 'read' });
  await checkDenied(403);
  await owner.action({ action: 'share-list', listId, userId: memberId, permission: 'none' });
  await checkDenied(404);
  state = await member.state();
  assert.deepEqual([state.lists, state.tasks, state.sheets], [[], [], []]);
  const otherId = await inviteMember(owner, other, { ...memberCredentials, email: 'other@example.com' });
  assert.equal((await other.state()).lists.length, 0);
  assert.equal((await owner.action({ action: 'share-list', listId, userId: otherId, permission: 'admin' })).status, 400);
  assert.equal((await owner.action({ action: 'share-list', listId, userId: 'missing', permission: 'read' })).status, 404);
  assert.equal((await owner.action({ action: 'share-list', listId, userId: (await owner.state()).me.id, permission: 'none' })).status, 400);
  assert.equal((await owner.state()).tasks[0].done, 1);
  assert.equal((await owner.state()).sheets[0].content, 'Secret text!');
  const sharedId = (await owner.action({ action: 'add-list', title: 'Separate shared list' })).data.listId;
  await owner.action({ action: 'share-list', listId: sharedId, userId: memberId, permission: 'edit' });
  assert.equal((await member.action({ action: 'add-task', listId: sharedId, text: 'Allowed here' })).status, 200);
  state = await member.state();
  assert.deepEqual(state.lists.map(list => list.id), [sharedId]);
  assert.deepEqual(state.tasks.map(task => task.text), ['Allowed here']);
  assert.deepEqual(state.sheets, []);
  await checkDenied(404);
});

test('members own private lists; notebook administration does not bypass list access', async t => {
  const { app, client } = await start(); t.after(() => app.close());
  const owner = client(), member = client();
  await owner.request('/api/setup', ownerCredentials);
  const memberId = await inviteMember(owner, member);
  const listId = (await member.action({ action: 'add-list', title: 'Personal' })).data.listId;
  assert.equal((await member.state()).lists[0].permission, 'owner');
  assert.equal((await owner.state()).lists.some(list => list.id === listId), false);
  assert.equal((await owner.action({ action: 'delete-list', listId })).status, 404);
  const ownerId = (await owner.state()).me.id;
  assert.equal((await owner.action({ action: 'share-list', listId, userId: ownerId, permission: 'edit' })).status, 404);
  await member.action({ action: 'share-list', listId, userId: ownerId, permission: 'read' });
  assert.equal((await owner.state()).lists.find(list => list.id === listId).permission, 'read');
  assert.equal((await owner.action({ action: 'rename-list', listId, title: 'Admin edit' })).status, 403);
  assert.equal((await owner.action({ action: 'remove-member', userId: memberId })).status, 409);
  assert.equal((await member.action({ action: 'delete-list', listId })).status, 200);
  await owner.action({ action: 'share-list', listId: (await owner.state()).lists[0].id, userId: memberId, permission: 'read' });
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM list_permissions').get().count, 1);
  assert.equal((await owner.action({ action: 'remove-member', userId: memberId })).status, 200);
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM list_permissions').get().count, 0);
  assert.equal((await member.request('/api/state')).status, 401);
});

test('legacy lists retain current collaborators once; grants and private lists survive restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'together-permissions-'));
  const filename = join(directory, 'legacy.sqlite');
  let running;
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE lists (id TEXT PRIMARY KEY, title TEXT NOT NULL, color TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO users VALUES ('owner', 'owner@example.com', 'Owner', '', 'owner', 1), ('member', 'member@example.com', 'Member', '', 'member', 2);
      INSERT INTO lists VALUES ('legacy', 'Legacy list', 'purple', 1);
      PRAGMA user_version = 2;`);
    legacy.close();
    running = await start(filename);
    let db = running.app.db;
    assert.equal(db.prepare('SELECT owner_id FROM lists').get().owner_id, 'owner');
    assert.equal(db.prepare('SELECT permission FROM list_permissions').get().permission, 'edit');
    const { createSession } = await import('../src/server/auth.mjs');
    const cookie = createSession(db, 'owner', false).split(';')[0];
    const action = async input => {
      const response = await fetch(running.origin + '/api/action', { method: 'POST', headers: { Cookie: cookie, Origin: running.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      assert.equal(response.status, 200); return response.json();
    };
    await action({ action: 'share-list', listId: 'legacy', userId: 'member', permission: 'read' });
    const privateId = (await action({ action: 'add-list', title: 'Private after upgrade' })).listId;
    await running.app.close(); running = null;
    running = await start(filename); db = running.app.db;
    assert.equal(db.prepare('SELECT permission FROM list_permissions WHERE list_id = ?').get('legacy').permission, 'read');
    assert.equal(db.prepare('SELECT count(*) AS count FROM list_permissions WHERE list_id = ?').get(privateId).count, 0);
    // A revoked legacy grant must not be restored by the migration on restart.
    await action({ action: 'share-list', listId: 'legacy', userId: 'member', permission: 'none' });
    await running.app.close(); running = null;
    running = await start(filename);
    assert.equal(running.app.db.prepare('SELECT count(*) AS count FROM list_permissions').get().count, 0);
    assert.equal(running.app.db.prepare('PRAGMA user_version').get().user_version, 4);
  } finally {
    if (running) await running.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('first account is the owner; all notebook data requires authentication', async t => {
  const { app, client } = await start(); t.after(() => app.close());
  const owner = client(), anonymous = client();
  assert.deepEqual((await anonymous.request('/api/session')).data, { user: null, setupNeeded: true });
  assert.equal((await anonymous.request('/api/state')).status, 401);
  assert.equal((await anonymous.action({ action: 'add-list', title: 'Unauthorized' })).status, 401);
  const setup = await owner.request('/api/setup', ownerCredentials);
  assert.equal(setup.status, 201);
  assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const state = await owner.state();
  assert.equal(state.me.role, 'owner');
  assert.equal(state.lists.length, 1);
  assert.equal(state.tasks.length, 0);
  assert.equal((await anonymous.request('/api/setup', memberCredentials)).status, 403);
  assert.equal((await anonymous.request('/api/register', memberCredentials)).status, 403);
  assert.equal((await anonymous.request('/api/login', { ...ownerCredentials, password: 'wrong password 123' })).status, 401);
  assert.equal((await owner.request('/api/logout', {})).status, 200);
  assert.equal((await owner.request('/api/state')).status, 401);
  assert.equal((await owner.request('/api/login', ownerCredentials)).status, 200);
});

test('invitations are email-bound, expiring, revocable, single-use, and owner-managed', async t => {
  const { app, client } = await start(); t.after(() => app.close());
  const owner = client(), member = client(), outsider = client();
  await owner.request('/api/setup', ownerCredentials);
  const invitation = await owner.action({ action: 'invite', email: 'SAM@example.com' });
  assert.equal(invitation.status, 200);
  const invite = new URL('http://test' + invitation.data.invitePath).searchParams.get('invite');
  assert.equal((await outsider.request('/api/invitation?token=' + invite)).data.email, undefined);
  assert.equal((await outsider.request('/api/register', { ...memberCredentials, email: 'outsider@example.com', invite })).status, 403);
  assert.equal((await member.request('/api/register', { ...memberCredentials, invite })).status, 201);
  const state = await member.state();
  assert.equal(state.me.role, 'member');
  assert.equal(state.members.length, 2);
  assert.equal(state.invitations.length, 0);
  assert.equal((await outsider.request('/api/invitation?token=' + invite)).status, 410);
  assert.equal((await member.action({ action: 'invite', email: 'someone@example.com' })).status, 403);
  assert.equal((await member.action({ action: 'remove-member', userId: state.members[0].id })).status, 403);
  const expiring = await owner.action({ action: 'invite', email: 'expired@example.com' });
  const expiredToken = new URL('http://test' + expiring.data.invitePath).searchParams.get('invite');
  app.db.prepare('UPDATE invitations SET expires_at = 1').run();
  assert.equal((await outsider.request('/api/register', { ...memberCredentials, email: 'expired@example.com', invite: expiredToken })).status, 410);
  const expired = await owner.state();
  assert.equal(expired.invitations.length, 0);
  const revocable = await owner.action({ action: 'invite', email: 'revoke@example.com' });
  const pending = (await owner.state()).invitations[0];
  await owner.action({ action: 'revoke-invite', inviteId: pending.id });
  const revokedToken = new URL('http://test' + revocable.data.invitePath).searchParams.get('invite');
  assert.equal((await outsider.request('/api/invitation?token=' + revokedToken)).status, 410);
  await owner.action({ action: 'remove-member', userId: state.me.id });
  assert.equal((await member.request('/api/state')).status, 401);
  assert.equal((await member.request('/api/login', memberCredentials)).status, 401);
});

test('two users edit shared lists; stale writes cannot overwrite a friend’s changes', async t => {
  const { app, client } = await start(); t.after(() => app.close());
  const owner = client(), friend = client();
  await owner.request('/api/setup', ownerCredentials);
  const invitation = await owner.action({ action: 'invite', email: memberCredentials.email });
  const invite = new URL('http://test' + invitation.data.invitePath).searchParams.get('invite');
  await friend.request('/api/register', { ...memberCredentials, invite });
  const added = await owner.action({ action: 'add-list', title: 'Weekend plans', color: 'green' });
  const listId = added.data.listId;
  await owner.action({ action: 'share-list', listId, userId: (await friend.state()).me.id, permission: 'edit' });
  const additions = await Promise.all([
    owner.action({ action: 'add-task', listId, text: 'Book the train' }),
    friend.action({ action: 'add-task', listId, text: 'Pack snacks' }),
  ]);
  assert.ok(additions.every(r => r.status === 200));
  let state = await friend.state();
  assert.equal(state.tasks.length, 2);
  const task = state.tasks[0];
  const concurrent = await Promise.all([
    owner.action({ action: 'update-task', taskId: task.id, version: task.version, done: true }),
    friend.action({ action: 'update-task', taskId: task.id, version: task.version, text: 'Changed concurrently' }),
  ]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  state = await owner.state();
  const currentTask = state.tasks.find(v => v.id === task.id);
  assert.equal(currentTask.version, task.version + 1);
  assert.equal((await owner.action({ action: 'delete-task', taskId: task.id, version: task.version })).status, 409);
  assert.equal((await friend.action({ action: 'update-task', taskId: task.id, version: currentTask.version, note: 'Meet at 10:00', done: false })).status, 200);
  await friend.action({ action: 'complete-list', listId });
  state = await owner.state();
  assert.ok(state.tasks.every(task => task.done === 1));
  await owner.action({ action: 'rename-list', listId, title: 'Our weekend' });
  assert.equal((await friend.state()).lists.find(l => l.id === listId).title, 'Our weekend');
  await owner.action({ action: 'delete-list', listId });
  assert.equal((await friend.state()).tasks.length, 0);
  assert.equal((await friend.action({ action: 'add-task', listId, text: 'Too late' })).status, 404);
});

test('owners and editors can bulk delete completed tasks only in the selected list', async t => {
  const { app, client } = await start(); t.after(() => app.close());
  const owner = client(), member = client();
  await owner.request('/api/setup', ownerCredentials);
  const memberId = await inviteMember(owner, member);
  const listId = (await owner.state()).lists[0].id;
  const otherListId = (await owner.action({ action: 'add-list', title: 'Other list' })).data.listId;
  for (const targetListId of [listId, otherListId]) {
    await owner.action({ action: 'add-task', listId: targetListId, text: 'Completed task' });
    await owner.action({ action: 'complete-list', listId: targetListId });
    await owner.action({ action: 'add-task', listId: targetListId, text: 'Open task' });
  }
  // A task reopened before deletion must be preserved, too.
  await owner.action({ action: 'add-task', listId, text: 'Reopened task' });
  const reopened = (await owner.state()).tasks.find(task => task.text === 'Reopened task');
  await owner.action({ action: 'update-task', taskId: reopened.id, version: reopened.version, done: true });
  await owner.action({ action: 'update-task', taskId: reopened.id, version: reopened.version + 1, done: false });
  await owner.action({ action: 'share-list', listId, userId: memberId, permission: 'read' });
  assert.equal((await member.action({ action: 'delete-completed-tasks', listId })).status, 403);
  const before = (await owner.state()).tasks;
  assert.equal(before.length, 5);
  await owner.action({ action: 'share-list', listId, userId: memberId, permission: 'edit' });
  assert.equal((await member.action({ action: 'delete-completed-tasks', listId })).status, 200);
  const remaining = (await owner.state()).tasks;
  assert.deepEqual(remaining, before.filter(task => task.list_id !== listId || !task.done));
  assert.equal((await member.state()).tasks.length, 2);
  assert.equal((await owner.action({ action: 'delete-completed-tasks', listId })).status, 200);
  assert.deepEqual((await owner.state()).tasks, remaining);
  assert.equal((await owner.action({ action: 'delete-completed-tasks', listId: otherListId })).status, 200);
  assert.deepEqual((await owner.state()).tasks, remaining.filter(task => task.list_id !== otherListId || !task.done));
});

test('live event stream reports changes and revoked sessions lose access', async t => {
  const { app, origin, client } = await start(); t.after(() => app.close());
  const owner = client();
  await owner.request('/api/setup', ownerCredentials);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(origin + '/api/events', { headers: { Cookie: owner.cookie }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: change/);
  const waitForChange = reader.read();
  await owner.action({ action: 'add-list', title: 'Live update' });
  const next = await Promise.race([waitForChange, new Promise((_, reject) => setTimeout(() => reject(new Error('No live update received')), 2000).unref())]);
  assert.match(new TextDecoder().decode(next.value), /event: change/);
  await owner.request('/api/logout', {});
  const ended = await reader.read();
  assert.equal(ended.done, true);
});

test('cross-origin writes, malformed input and unsafe static paths are rejected', async t => {
  const { app, origin, client } = await start(); t.after(() => app.close());
  const owner = client();
  await owner.request('/api/setup', ownerCredentials);
  assert.equal((await owner.request('/api/action', { action: 'add-list', title: 'CSRF' }, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await owner.action({ action: 'add-list', title: ' ' })).status, 400);
  assert.equal((await owner.action({ action: 'add-list', title: 'x'.repeat(81) })).status, 400);
  const malformed = await fetch(origin + '/api/action', { method: 'POST', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(origin + '/api/action', { method: 'POST', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add-list', title: 'x'.repeat(17000) }) });
  assert.equal(oversized.status, 413);
  assert.equal((await fetch(origin + '/server/app.mjs')).status, 404);
  assert.equal((await fetch(origin + '/src/server/app.mjs')).status, 404);
  const page = await fetch(origin + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await page.text(), /lang="en"/);
});

test('browser assets are served from the application source directory', async t => {
  const { app, origin } = await start(); t.after(() => app.close());
  for (const [path, type] of [
    ['/style.css', 'text/css'],
    ['/app.js', 'text/javascript'],
    ['/text-operations.js', 'text/javascript'],
    ['/markdown.js', 'text/javascript'],
    ['/vendor/marked.js', 'text/javascript'],
    ['/vendor/dompurify.js', 'text/javascript'],
    ['/theme.js', 'text/javascript'],
    ['/favicon.svg', 'image/svg+xml'],
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-type').startsWith(type), path);
    assert.ok((await response.text()).length > 0, path);
  }
});

test('password changes invalidate other sessions and secure hosting sets Secure cookies', async t => {
  const { app, client } = await start(':memory:', 'https://todo.example.com'); t.after(() => app.close());
  const owner = client(), other = client();
  const setup = await owner.request('/api/setup', ownerCredentials, { Origin: 'https://todo.example.com' });
  assert.equal(setup.status, 201);
  assert.match(setup.headers.get('set-cookie'), /; Secure/);
  await other.request('/api/login', ownerCredentials, { Origin: 'https://todo.example.com' });
  const changed = await owner.request('/api/password', { currentPassword: ownerCredentials.password, password: 'a brand new password' }, { Origin: 'https://todo.example.com' });
  assert.equal(changed.status, 200);
  assert.equal((await other.request('/api/state')).status, 401);
  assert.equal((await owner.request('/api/state')).status, 200);
});

test('notebook data and accounts survive a server restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'together-test-'));
  const filename = join(directory, 'notebook.sqlite');
  let running;
  try {
    running = await start(filename);
    const owner = running.client();
    await owner.request('/api/setup', ownerCredentials);
    const listId = (await owner.state()).lists[0].id;
    await owner.action({ action: 'add-task', listId, text: 'Persist across restarts' });
    const sheetId = (await owner.action({ action: 'add-sheet', listId, title: 'Persistent notes' })).data.sheetId;
    await owner.request('/api/sheet', { sheetId, version: 0, operationId: 'persisted-save', operation: ['  Notes 📝\n\n'] });
    const savedCookie = owner.cookie;
    await running.app.close(); running = null;
    running = await start(filename);
    const existingSession = await fetch(running.origin + '/api/state', { headers: { Cookie: savedCookie } });
    assert.equal(existingSession.status, 200);
    const returning = running.client();
    assert.equal((await returning.request('/api/login', ownerCredentials)).status, 200);
    assert.equal((await returning.state()).tasks[0].text, 'Persist across restarts');
    const persistedSheet = (await returning.state()).sheets[0];
    assert.equal(persistedSheet.content, '  Notes 📝\n\n');
    assert.equal(persistedSheet.version, 1);
    assert.equal(persistedSheet.changes[0].operation_id, 'persisted-save');
  } finally {
    if (running) await running.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('members share independent text sheets and concurrent edits merge with idempotent retries', async t => {
  const { app, client } = await start(); t.after(() => app.close());
  const owner = client(), friend = client(), anonymous = client();
  await owner.request('/api/setup', ownerCredentials);
  const invitation = await owner.action({ action: 'invite', email: memberCredentials.email });
  const invite = new URL('http://test' + invitation.data.invitePath).searchParams.get('invite');
  await friend.request('/api/register', { ...memberCredentials, invite });
  const listId = (await owner.state()).lists[0].id;
  await owner.action({ action: 'share-list', listId, userId: (await friend.state()).me.id, permission: 'edit' });
  assert.equal((await anonymous.action({ action: 'add-sheet', listId, title: 'Private' })).status, 401);
  assert.equal((await anonymous.request('/api/sheet', {})).status, 401);
  const sheetId = (await owner.action({ action: 'add-sheet', listId, title: 'Sheet 1' })).data.sheetId;
  const otherId = (await friend.action({ action: 'add-sheet', listId, title: 'Sheet 2' })).data.sheetId;
  const save = (who, id, version, operationId, before, after) => who.request('/api/sheet', { sheetId: id, version, operationId, operation: difference(before, after) });
  await save(owner, sheetId, 0, 'initial', '', 'hello world');
  const concurrent = await Promise.all([
    save(owner, sheetId, 1, 'owner-edit', 'hello world', 'Hello world'),
    save(friend, sheetId, 1, 'friend-edit', 'hello world', 'hello world!'),
  ]);
  assert.deepEqual(concurrent.map(result => result.status), [200, 200]);
  let sheet = (await friend.state()).sheets.find(item => item.id === sheetId);
  assert.equal(sheet.content, 'Hello world!');
  assert.equal(sheet.version, 3);
  assert.equal((await save(friend, sheetId, 1, 'friend-edit', 'hello world', 'hello world!')).status, 200);
  assert.equal((await friend.state()).sheets.find(item => item.id === sheetId).version, 3);
  assert.equal((await save(friend, otherId, 0, 'friend-edit', '', 'Reused identifier')).status, 409);
  assert.equal((await owner.action({ action: 'delete-sheet', sheetId, version: 1 })).status, 409);
  assert.equal((await friend.action({ action: 'rename-sheet', sheetId, title: 'Meeting notes' })).status, 200);
  sheet = (await owner.state()).sheets.find(item => item.id === sheetId);
  assert.equal(sheet.title, 'Meeting notes');
  assert.equal(sheet.content, 'Hello world!');
  assert.equal((await owner.state()).sheets.find(item => item.id === otherId).content, '');
  assert.equal((await save(friend, otherId, 0, 'large-save', '', 'ä'.repeat(50000))).status, 200);
  assert.equal((await friend.request('/api/sheet', { sheetId, version: 3, operationId: 'malformed', operation: [null] })).status, 400);
  assert.equal((await friend.request('/api/sheet', { sheetId, version: 99, operationId: 'future', operation: [] })).status, 400);
  assert.equal((await friend.action({ action: 'add-sheet', listId: 'missing', title: 'Sheet' })).status, 404);
  assert.equal((await friend.action({ action: 'add-sheet', listId, title: ' ' })).status, 400);
  assert.equal((await owner.action({ action: 'delete-sheet', sheetId, version: 3 })).status, 200);
  assert.equal((await save(friend, sheetId, 3, 'deleted', sheet.content, 'Lost')).status, 404);
  await owner.action({ action: 'delete-list', listId });
  assert.equal((await friend.state()).sheets.length, 0);
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM text_changes').get().count, 0);
});
