import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.mjs';

const primary = 'http://192.0.2.10:3000';
const additional = 'http://together.example.test';

async function start(t, allowedOrigins = '') {
  const app = await createApp({ database: ':memory:', appUrl: primary, allowedOrigins });
  t.after(() => app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${app.server.address().port}`;
  return (path, origin, input = {}, headers = {}) => fetch(address + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    body: JSON.stringify(input),
  });
}

test('explicit additional origin permits writes while the original address and authentication remain intact', async t => {
  const request = await start(t, additional);
  const setup = await request('/api/setup', additional, { name: 'Origin test', email: 'origin@example.test', password: 'origin test password' });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  for (const origin of [primary, additional]) {
    assert.equal((await request('/api/action', origin, { action: 'add-list', title: 'Origin test' }, { Cookie: cookie })).status, 200);
    assert.equal((await request('/api/action', origin, { action: 'add-list', title: 'Denied' })).status, 401);
  }
  for (const origin of ['http://foreign.invalid', 'http://sub.together.example.test', 'http://together.example.test:3000', 'https://together.example.test', 'null']) {
    assert.equal((await request('/api/action', origin, { action: 'add-list', title: 'Denied' }, { Cookie: cookie })).status, 403);
  }
  assert.equal((await request('/api/action', additional, { action: 'add-list', title: 'Denied' }, { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});

test('additional origins are opt-in and whitespace-separated comma entries are exact', async t => {
  const originalOnly = await start(t);
  assert.equal((await originalOnly('/api/action', additional)).status, 403);
  assert.equal((await originalOnly('/api/action', primary)).status, 401);
  const extra = await start(t, ` ${additional}, https://other.example.test `);
  assert.equal((await extra('/api/action', 'https://other.example.test')).status, 401);
  assert.equal((await extra('/api/action', 'https://sub.other.example.test')).status, 403);
});

test('invalid or broad additional origins fail closed before opening the database', async () => {
  for (const allowedOrigins of ['*', 'http://*.example.test', 'http://together.example.test/', 'http://together.example.test/path', 'http://together.example.test?query=1', 'http://user:password@together.example.test', 'file:///tmp/test', 'null']) {
    await assert.rejects(createApp({ database: ':memory:', appUrl: primary, allowedOrigins }));
  }
});
