import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.mjs';

async function start(t, nameOnlyLogin) {
  const app = await createApp({ database: ':memory:', nameOnlyLogin });
  t.after(() => app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  function client() {
    let cookie = '';
    return async (path, input, extraHeaders = {}) => {
      const response = await fetch(origin + '/api/' + path, {
        ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }),
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...extraHeaders },
      });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, data: await response.json(), headers: response.headers };
    };
  }
  return { app, client };
}

test('local name login creates and reuses accounts, retaining permissions and logout', async t => {
  const { client } = await start(t, true);
  const owner = client(), member = client(), returning = client();
  assert.equal((await owner('session')).data.nameOnlyLogin, true);
  assert.equal((await owner('state')).status, 401);
  const login = await owner('login', { name: ' Alex ' });
  assert.equal(login.status, 201);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const original = (await owner('state')).data;
  assert.equal(original.me.name, 'Alex');
  assert.equal(original.me.role, 'owner');
  assert.equal(original.maxFileSize, 10737418240);
  assert.equal((await member('login', { name: 'Sam' })).status, 201);
  const memberState = (await member('state')).data;
  assert.equal(memberState.me.role, 'member');
  assert.deepEqual(memberState.lists, []);
  assert.equal((await member('action', { action: 'add-task', listId: original.lists[0].id, text: 'Denied' })).status, 404);
  assert.equal((await owner('action', { action: 'share-list', listId: original.lists[0].id, userId: memberState.me.id, permission: 'edit' })).status, 200);
  assert.equal((await member('action', { action: 'add-task', listId: original.lists[0].id, text: 'Shared task' })).status, 200);
  assert.equal((await returning('login', { name: 'aLEX' })).status, 200);
  assert.equal((await returning('state')).data.me.id, original.me.id);
  assert.equal((await returning('state')).data.tasks[0].text, 'Shared task');
  assert.equal((await returning('logout', {})).status, 200);
  assert.equal((await returning('session')).data.user, null);
  assert.equal((await returning('state')).status, 401);
  assert.equal((await returning('login', { name: 'sam' })).status, 200);
  assert.equal((await returning('state')).data.me.id, memberState.me.id);
});

test('local name login validates names, rejects cross-origin login and ambiguous existing names', async t => {
  const { app, client } = await start(t, true);
  const request = client();
  for (const name of [undefined, null, '', '  ', 123, 'x'.repeat(61)]) {
    assert.equal((await request('login', { name })).status, 400);
  }
  assert.equal((await request('login', { name: 'Alex' }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await request('setup', {})).status, 403);
  assert.equal((await request('register', {})).status, 403);
  assert.equal((await request('login', { name: 'Zoë' })).status, 201);
  const id = (await request('state')).data.me.id;
  assert.equal((await request('login', { name: 'Zoe\u0308' })).status, 200);
  assert.equal((await request('state')).data.me.id, id);
  app.db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run('duplicate', 'duplicate@example.test', 'ZOË', 'unused', 'member', Date.now());
  assert.equal((await request('login', { name: 'Zoë' })).status, 409);
});

test('password mode is the default and existing password accounts work by name without changing passwords', async t => {
  const { app, client } = await start(t, false);
  const request = client();
  assert.equal((await request('session')).data.nameOnlyLogin, false);
  assert.equal((await request('login', { name: 'Alex' })).status, 400);
  const credentials = { name: 'Alex', email: 'alex@example.test', password: 'existing password' };
  assert.equal((await request('setup', credentials)).status, 201);
  const original = app.db.prepare('SELECT * FROM users').get();
  const nameApp = await createApp({ database: ':memory:', nameOnlyLogin: true });
  t.after(() => nameApp.close());
  nameApp.db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(original.id, original.email, original.name, original.password_hash, original.role, original.created_at);
  await new Promise(resolve => nameApp.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${nameApp.server.address().port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Alex' }) });
  assert.equal(response.status, 200);
  await response.json();
  assert.deepEqual(nameApp.db.prepare('SELECT * FROM users').get(), original);
  await request('logout', {});
  assert.equal((await request('login', credentials)).status, 200);
});
