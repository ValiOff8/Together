import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp, FILE_LIFETIME, MAX_FILE_SIZE, MAX_FILE_LIFETIME_MINUTES } from '../src/server/app.mjs';

test('default file upload limit is 10 GiB', () => {
  assert.equal(MAX_FILE_SIZE, 10737418240);
});

async function notebook(t) {
  const directory = await mkdtemp(join(tmpdir(), 'together-file-tests-'));
  const database = join(directory, 'notebook.sqlite');
  const uploads = database + '-files';
  let app, origin;
  const restart = async () => {
    if (app) await app.close();
    app = await createApp({ database });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${app.server.address().port}`;
  };
  t.after(async () => {
    if (app) await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  await restart();
  function client() {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async request(path, input) {
        const response = await fetch(origin + path, {
          ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }),
          headers: { Cookie: cookie, ...(input === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }) },
        });
        if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        return { status: response.status, data: await response.json() };
      },
      action(input) { return this.request('/api/action', input); },
      async state() { const result = await this.request('/api/state'); assert.equal(result.status, 200); return result.data; },
      upload(listId, name, content = Buffer.from('shared content'), headers = {}) {
        return fetch(`${origin}/api/files?${new URLSearchParams({ listId, name })}`, {
          method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/octet-stream', ...headers }, body: content,
        });
      },
      download(id) { return fetch(`${origin}/api/files/${id}`, { headers: { Cookie: cookie } }); },
    };
  }
  const owner = client();
  assert.equal((await owner.request('/api/setup', { name: 'Alex', email: 'alex@example.test', password: 'file test password' })).status, 201);
  const listId = (await owner.state()).lists[0].id;
  return { get app() { return app; }, get origin() { return origin; }, uploads, restart, owner, listId, client };
}

async function member(owner, client) {
  const invitation = await owner.action({ action: 'invite', email: 'sam@example.test' });
  const invite = new URL(invitation.data.invitePath, 'http://app.test').searchParams.get('invite');
  assert.equal((await client.request('/api/register', { invite, name: 'Sam', email: 'sam@example.test', password: 'member test password' })).status, 201);
  return (await client.state()).me.id;
}

test('only the notebook owner can change the persistent upload limit', async t => {
  const book = await notebook(t);
  const { owner, listId, client } = book;
  const friend = client();
  await member(owner, friend);
  assert.equal((await owner.state()).maxFileSize, MAX_FILE_SIZE);
  assert.equal((await friend.action({ action: 'set-upload-limit', maxFileSize: 4 })).status, 403);
  assert.equal((await client().action({ action: 'set-upload-limit', maxFileSize: 4 })).status, 401);
  for (const maxFileSize of [undefined, 0, -1, 1.5, '4', null, true, {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await owner.action({ action: 'set-upload-limit', maxFileSize })).status, 400);
  }
  assert.equal((await owner.state()).maxFileSize, MAX_FILE_SIZE);
  const existing = await owner.upload(listId, 'existing.txt', 'larger than new limit');
  const { fileId } = await existing.json();
  const revision = (await owner.state()).revision;
  assert.equal((await owner.action({ action: 'set-upload-limit', maxFileSize: 4 })).status, 200);
  assert.ok((await owner.state()).revision > revision);
  assert.equal((await friend.state()).maxFileSize, 4);
  assert.equal((await owner.upload(listId, 'fits.txt', '1234')).status, 201);
  const oversized = await owner.upload(listId, 'too-big.txt', '12345');
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).error, /4 bytes/);
  await book.restart();
  assert.equal((await owner.state()).maxFileSize, 4);
  assert.equal(await (await owner.download(fileId)).text(), 'larger than new limit');
  assert.equal((await owner.action({ action: 'set-upload-limit', maxFileSize: MAX_FILE_SIZE * 2 })).status, 200);
  assert.equal((await owner.state()).maxFileSize, MAX_FILE_SIZE * 2);
  assert.equal((await owner.upload(listId, 'fits-again.txt', '12345')).status, 201);
  assert.equal((await owner.action({ action: 'set-upload-limit', maxFileSize: Number.MAX_SAFE_INTEGER })).status, 200);
  assert.equal((await owner.state()).maxFileSize, Number.MAX_SAFE_INTEGER);
});

test('files retain original bytes and Unicode names, expire in 48 hours, persist, and delete from disk', async t => {
  const book = await notebook(t);
  const { owner, listId } = book;
  const bytes = Buffer.from([0, 255, 13, 10, 42, 128, 0]);
  const before = Date.now();
  const upload = await owner.upload(listId, 'Überblick (final).bin', bytes);
  assert.equal(upload.status, 201);
  const { fileId } = await upload.json();
  const state = await owner.state();
  const file = state.files[0];
  assert.equal(file.id, fileId);
  assert.equal(file.name, 'Überblick (final).bin');
  assert.equal(file.size, bytes.length);
  assert.equal(file.uploaded_by, state.me.id);
  assert.ok(file.created_at >= before && file.created_at <= Date.now());
  assert.equal(file.expires_at - file.created_at, FILE_LIFETIME);
  assert.equal(FILE_LIFETIME, 48 * 60 * 60 * 1000);
  assert.deepEqual(await readFile(join(book.uploads, fileId)), bytes);
  await book.restart();
  const response = await owner.download(fileId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('content-disposition').includes("filename*=UTF-8''%C3%9Cberblick%20%28final%29.bin"));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await owner.action({ action: 'delete-file', fileId })).status, 200);
  assert.deepEqual((await owner.state()).files, []);
  assert.deepEqual(await readdir(book.uploads), []);
  assert.equal((await owner.download(fileId)).status, 404);
  assert.equal((await owner.upload(listId, 'empty.txt', Buffer.alloc(0))).status, 201);
});

test('file listing, upload, download, deletion, and revocation obey list permissions', async t => {
  const { owner, listId, client, uploads } = await notebook(t);
  const friend = client(), anonymous = client();
  const friendId = await member(owner, friend);
  const fileId = (await (await owner.upload(listId, 'private.txt')).json()).fileId;
  const denied = async status => {
    assert.equal((await friend.upload(listId, 'denied.txt')).status, status);
    assert.equal((await friend.action({ action: 'delete-file', fileId })).status, status);
    assert.equal((await friend.action({ action: 'set-file-expiry', fileId, minutes: 60 })).status, status);
  };
  assert.equal((await anonymous.upload(listId, 'anonymous.txt')).status, 401);
  assert.equal((await anonymous.download(fileId)).status, 401);
  assert.equal((await anonymous.action({ action: 'set-file-expiry', fileId, minutes: 60 })).status, 401);
  assert.deepEqual((await friend.state()).files, []);
  assert.equal((await friend.download(fileId)).status, 404);
  await denied(404);
  await owner.action({ action: 'share-list', listId, userId: friendId, permission: 'read' });
  assert.equal((await friend.state()).files.length, 1);
  const download = await friend.download(fileId);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'shared content');
  await denied(403);
  await owner.action({ action: 'share-list', listId, userId: friendId, permission: 'edit' });
  assert.equal((await friend.action({ action: 'set-file-expiry', fileId, minutes: 60 })).status, 200);
  const second = (await (await friend.upload(listId, 'friend.txt')).json()).fileId;
  assert.equal((await friend.action({ action: 'delete-file', fileId: second })).status, 200);
  await owner.action({ action: 'share-list', listId, userId: friendId, permission: 'none' });
  await denied(404);
  assert.equal((await friend.download(fileId)).status, 404);
  assert.deepEqual((await friend.state()).files, []);
  assert.deepEqual(await readdir(uploads), [fileId]);
  await owner.action({ action: 'delete-list', listId });
  assert.deepEqual(await readdir(uploads), []);
});

test('custom deletion times persist, validate bounds, and cannot restore expired files', async t => {
  const book = await notebook(t);
  const { owner, listId } = book;
  const fileId = (await (await owner.upload(listId, 'adjustable.txt')).json()).fileId;
  const original = (await owner.state()).files[0];
  const before = Date.now();
  assert.equal((await owner.action({ action: 'set-file-expiry', fileId, minutes: MAX_FILE_LIFETIME_MINUTES })).status, 200);
  const changed = (await owner.state()).files[0];
  assert.equal(changed.created_at, original.created_at);
  assert.ok(changed.expires_at >= before + MAX_FILE_LIFETIME_MINUTES * 60000);
  assert.ok(changed.expires_at <= Date.now() + MAX_FILE_LIFETIME_MINUTES * 60000);
  for (const minutes of [undefined, null, '60', 0, -1, 0.5, MAX_FILE_LIFETIME_MINUTES + 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal((await owner.action({ action: 'set-file-expiry', fileId, minutes })).status, 400);
    assert.equal((await owner.state()).files[0].expires_at, changed.expires_at);
  }
  await book.restart();
  assert.equal((await owner.state()).files[0].expires_at, changed.expires_at);
  const download = await owner.download(fileId);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'shared content');
  assert.equal((await owner.action({ action: 'set-file-expiry', fileId, minutes: 1 })).status, 200);
  const expiry = (await owner.state()).files[0].expires_at;
  assert.ok(expiry < changed.expires_at);
  t.mock.timers.enable({ apis: ['Date'], now: expiry });
  assert.equal((await owner.download(fileId)).status, 410);
  assert.equal((await owner.action({ action: 'set-file-expiry', fileId, minutes: 60 })).status, 410);
  assert.deepEqual((await owner.state()).files, []);
  t.mock.timers.reset();
  assert.equal((await owner.action({ action: 'set-file-expiry', fileId: 'missing', minutes: 60 })).status, 404);
});

test('extending a deletion time cancels the previous automatic deletion', async t => {
  const book = await notebook(t);
  const { owner, listId } = book;
  const fileId = (await (await owner.upload(listId, 'extended.txt')).json()).fileId;
  book.app.db.prepare('UPDATE shared_files SET expires_at = ? WHERE id = ?').run(Date.now() + 400, fileId);
  await book.restart();
  const revision = (await owner.state()).revision;
  assert.equal((await owner.action({ action: 'set-file-expiry', fileId, minutes: 60 })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(await readdir(book.uploads), [fileId]);
  const state = await owner.state();
  assert.equal(state.files.length, 1);
  assert.ok(state.revision > revision);
  const response = await owner.download(fileId);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
});

test('expiry blocks downloads immediately, cleans up on restart, and removes files without browser requests', async t => {
  const book = await notebook(t);
  const { owner, listId } = book;
  const first = (await (await owner.upload(listId, 'expired.txt')).json()).fileId;
  book.app.db.prepare('UPDATE shared_files SET expires_at = ? WHERE id = ?').run(Date.now(), first);
  assert.deepEqual((await owner.state()).files, []);
  assert.equal((await owner.download(first)).status, 410);
  const second = (await (await owner.upload(listId, 'expires-soon.txt')).json()).fileId;
  // A persisted future expiry must schedule a background deletion after restart.
  book.app.db.prepare('UPDATE shared_files SET expires_at = ? WHERE id = ?').run(Date.now() + 400, second);
  await writeFile(join(book.uploads, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'interrupted upload');
  await book.restart();
  assert.deepEqual(await readdir(book.uploads), [second]);
  const revision = (await owner.state()).revision;
  await new Promise(resolve => setTimeout(resolve, 500));
  // Inspect disk and database before making another HTTP request.
  assert.deepEqual(await readdir(book.uploads), []);
  assert.equal(book.app.db.prepare('SELECT count(*) AS total FROM shared_files').get().total, 0);
  assert.ok((await owner.state()).revision > revision);
});

test('uploads reject unsafe names, cross-origin requests, wrong types, and oversized streamed bodies', async t => {
  const { owner, listId, uploads, origin } = await notebook(t);
  for (const name of ['../outside.txt', 'folder\\file.txt', 'bad\r\nname', '.', '..', 'x'.repeat(256)]) {
    assert.equal((await owner.upload(listId, name)).status, 400, name);
  }
  assert.equal((await owner.upload(listId, 'safe.txt', 'text', { Origin: 'https://other.example' })).status, 403);
  assert.equal((await owner.upload(listId, 'safe.txt', 'text', { 'Content-Type': 'text/html' })).status, 415);
  const limit = 1024 * 1024;
  assert.equal((await owner.action({ action: 'set-upload-limit', maxFileSize: limit })).status, 200);
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/api/files?${new URLSearchParams({ listId, name: 'large.bin' })}`, {
      method: 'POST', headers: { Cookie: owner.cookie, Origin: origin, 'Content-Type': 'application/octet-stream' },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    const chunk = Buffer.alloc(256 * 1024);
    let remaining = limit + 1;
    const send = () => {
      while (remaining > 0) {
        const part = chunk.subarray(0, Math.min(remaining, chunk.length));
        remaining -= part.length;
        if (!request.write(part)) { request.once('drain', send); return; }
      }
      request.end();
    };
    send();
  });
  assert.equal(response, 413);
  assert.deepEqual((await owner.state()).files, []);
  assert.deepEqual(await readdir(uploads), []);
});

test('an editor whose access is revoked during an upload cannot leave a stored file', async t => {
  const { owner, listId, client, uploads, origin } = await notebook(t);
  const friend = client();
  const friendId = await member(owner, friend);
  await owner.action({ action: 'share-list', listId, userId: friendId, permission: 'edit' });
  let request;
  const completed = new Promise((resolve, reject) => {
    request = httpRequest(`${origin}/api/files?${new URLSearchParams({ listId, name: 'revoked.txt' })}`, {
      method: 'POST', headers: { Cookie: friend.cookie, Origin: origin, 'Content-Type': 'application/octet-stream' },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.write('first chunk');
  });
  t.after(() => request.destroy());
  // Wait for the server to begin storing the upload before revoking access.
  for (let i = 0; !(await readdir(uploads)).length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await readdir(uploads)).length, 1);
  await owner.action({ action: 'share-list', listId, userId: friendId, permission: 'none' });
  request.end('last chunk');
  assert.equal(await completed, 404);
  assert.deepEqual(await readdir(uploads), []);
  assert.deepEqual((await owner.state()).files, []);
});
