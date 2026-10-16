import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.mjs';

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
    const savedCookie = owner.cookie;
    await running.app.close(); running = null;
    running = await start(filename);
    const existingSession = await fetch(running.origin + '/api/state', { headers: { Cookie: savedCookie } });
    assert.equal(existingSession.status, 200);
    const returning = running.client();
    assert.equal((await returning.request('/api/login', ownerCredentials)).status, 200);
    assert.equal((await returning.state()).tasks[0].text, 'Persist across restarts');
  } finally {
    if (running) await running.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
