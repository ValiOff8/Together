import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, open, mkdtemp } from 'node:fs/promises';
import { mkdirSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { openDatabase, transaction } from './database.mjs';
import { token, hash, passwordHash, checkPassword, sessionUser, sessionToken, createSession } from './auth.mjs';
import { applyOperation, operationLengths, transformOperations } from '../web/text-operations.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const publicUser = (user) => ({ id: user.id, email: user.email, name: user.name, role: user.role });
export const FILE_LIFETIME = 48 * 60 * 60 * 1000;
export const MAX_FILE_LIFETIME_MINUTES = 30 * 24 * 60;
export const MAX_FILE_SIZE = 100 * 1024 * 1024;
function text(input, key, max = 200) {
  if (typeof input[key] !== 'string' || !input[key].trim() || input[key].trim().length > max) fail(400, `Please enter a valid ${key} (up to ${max} characters).`);
  return input[key].trim();
}
function credentials(input) {
  const email = text(input, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email address.');
  if (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 128) fail(400, 'Use a password with 10 to 128 characters.');
  return { email, password: input.password };
}
async function body(request, limit = 16000) {
  if (!request.headers['content-type']?.startsWith('application/json')) fail(415, 'Please send JSON.');
  if (Number(request.headers['content-length']) > limit) fail(413, 'That request is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail(413, 'That request is too large.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let input;
  try { input = JSON.parse(raw); } catch { fail(400, 'The request could not be read.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Invalid request.');
  return input;
}

export async function createApp({ database = process.env.DATABASE_PATH || './data/together.sqlite', appUrl = process.env.APP_URL || '' } = {}) {
  const db = openDatabase(database);
  const uploadDirectory = database === ':memory:' ? await mkdtemp(join(tmpdir(), 'together-files-')) : join(dirname(resolve(database)), basename(database) + '-files');
  mkdirSync(uploadDirectory, { recursive: true });
  const activeUploads = new Set();
  const filePath = id => join(uploadDirectory, id);
  let expiryTimer;
  let closing = false;
  const configuredOrigin = appUrl ? new URL(appUrl).origin : '';
  const secure = configuredOrigin.startsWith('https:');
  const clients = new Set();
  const attempts = new Map();
  const dummyPassword = await passwordHash(token());
  const revision = () => Number(db.prepare("SELECT value FROM settings WHERE key = 'revision'").get().value);
  const bump = () => db.prepare("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run();
  const ownerOnly = user => { if (user.role !== 'owner') fail(403, 'Only the notebook owner can manage access.'); };
  const validClient = client => Boolean(db.prepare('SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND s.expires_at > ?').get(client.sessionHash, Date.now()));
  function broadcast() {
    for (const client of clients) {
      if (!validClient(client)) { clients.delete(client); client.response.end(); }
      else client.response.write(`event: change\ndata: ${revision()}\n\n`);
    }
  }
  function scheduleExpiry(delay) {
    clearTimeout(expiryTimer);
    if (closing) return;
    const next = db.prepare('SELECT MIN(expires_at) AS expiry FROM shared_files').get().expiry;
    expiryTimer = setTimeout(() => {
      try { cleanupFiles(); }
      catch (error) { console.error('File cleanup failed:', error); scheduleExpiry(60000); }
    }, delay ?? (next === null ? 60000 : Math.max(1, Math.min(60000, next - Date.now()))));
    expiryTimer.unref();
  }
  function cleanupFiles() {
    const expired = db.prepare('SELECT id FROM shared_files WHERE expires_at <= ?').all(Date.now());
    for (const file of expired) rmSync(filePath(file.id), { force: true });
    if (expired.length) {
      transaction(db, () => {
        for (const file of expired) db.prepare('DELETE FROM shared_files WHERE id = ?').run(file.id);
        bump();
      });
      broadcast();
    }
    // Recover files left by interrupted uploads or a crash after deleting a list.
    const live = new Set(db.prepare('SELECT id FROM shared_files').all().map(file => file.id));
    for (const name of readdirSync(uploadDirectory)) {
      if (/^[a-f0-9-]{36}(?:\.part)?$/.test(name) && !live.has(name) && !activeUploads.has(name.replace(/\.part$/, ''))) rmSync(filePath(name), { force: true });
    }
    scheduleExpiry();
  }
  cleanupFiles();
  function rateLimit(request, email = '') {
    const now = Date.now();
    for (const key of [request.socket.remoteAddress || 'unknown', 'email:' + hash(email)]) {
      const entry = attempts.get(key);
      if (entry && entry.until > now && entry.count >= 20) fail(429, 'Too many attempts. Please try again in 15 minutes.');
      if (!entry || entry.until <= now) attempts.set(key, { count: 1, until: now + 900000 });
      else entry.count++;
    }
  }
  function snapshot(user) {
    const onlineIds = new Set([...clients].map(client => client.userId));
    const lists = db.prepare(`SELECT l.*, CASE WHEN l.owner_id = ? THEN 'owner' ELSE p.permission END AS permission
      FROM lists l LEFT JOIN list_permissions p ON p.list_id = l.id AND p.user_id = ?
      WHERE l.owner_id = ? OR p.user_id IS NOT NULL ORDER BY l.created_at, l.id`).all(user.id, user.id, user.id);
    const visible = new Set(lists.map(list => list.id));
    return {
      revision: revision(), name: db.prepare("SELECT value FROM settings WHERE key = 'name'").get().value,
      me: publicUser(user),
      lists: lists.map(list => ({ ...list, grants: list.permission === 'owner'
        ? db.prepare('SELECT user_id, permission FROM list_permissions WHERE list_id = ? ORDER BY user_id').all(list.id) : [] })),
      tasks: db.prepare('SELECT * FROM tasks ORDER BY created_at, id').all().filter(task => visible.has(task.list_id)),
      sheets: db.prepare('SELECT * FROM text_sheets ORDER BY created_at, id').all().filter(sheet => visible.has(sheet.list_id)).map(sheet => sheetSnapshot(sheet)),
      files: db.prepare('SELECT * FROM shared_files WHERE expires_at > ? ORDER BY created_at, id').all(Date.now()).filter(file => visible.has(file.list_id)),
      maxFileSize: MAX_FILE_SIZE,
      maxFileLifetimeMinutes: MAX_FILE_LIFETIME_MINUTES,
      members: db.prepare('SELECT id, name, email, role FROM users ORDER BY created_at').all().map(m => ({ ...m, online: onlineIds.has(m.id) })),
      invitations: user.role === 'owner' ? db.prepare('SELECT id, email, expires_at FROM invitations WHERE expires_at > ? ORDER BY created_at').all(Date.now()) : [],
    };
  }
  function sheetSnapshot(sheet, since = Math.max(0, sheet.version - 100)) {
    return { ...sheet, changes: db.prepare('SELECT version, operation_id, operation FROM text_changes WHERE sheet_id = ? AND version > ? ORDER BY version').all(sheet.id, since).map(change => ({ ...change, operation: JSON.parse(change.operation) })) };
  }
  function access(user, id, required = 'edit') {
    const row = db.prepare(`SELECT l.owner_id, p.permission FROM lists l
      LEFT JOIN list_permissions p ON p.list_id = l.id AND p.user_id = ? WHERE l.id = ?`).get(user.id, id);
    if (!row || (row.owner_id !== user.id && !row.permission)) fail(404, 'This list is unavailable.');
    if (row.owner_id !== user.id && required !== 'read' && (required === 'owner' || row.permission !== 'edit')) fail(403, 'You do not have permission to make this change.');
    return id;
  }
  function list(user, input, required = 'edit') {
    const id = text(input, 'listId', 100);
    access(user, id, required);
    return id;
  }
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/text-operations.js', ['text-operations.js', 'text/javascript; charset=utf-8']],
    ['/markdown.js', ['markdown.js', 'text/javascript; charset=utf-8']],
    ['/vendor/marked.js', ['vendor/marked.js', 'text/javascript; charset=utf-8']],
    ['/vendor/dompurify.js', ['vendor/dompurify.js', 'text/javascript; charset=utf-8']],
    ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ]);

  const server = createServer(async (request, response) => {
    const respond = (data, status = 200, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      response.end(JSON.stringify(data));
    };
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://app.local');
      const method = request.method;
      if (url.pathname === '/health' && method === 'GET') return respond({ status: 'ok' });
      if (method === 'GET' && assets.has(url.pathname)) {
        const [filename, type] = assets.get(url.pathname);
        const content = await readFile(new URL('../web/' + filename, import.meta.url));
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return response.end(content);
      }
      if (!url.pathname.startsWith('/api/')) fail(404, 'Not found.');
      const user = sessionUser(db, request);
      if (method === 'GET' && url.pathname === '/api/session') {
        return respond({ user: user ? publicUser(user) : null, setupNeeded: !db.prepare('SELECT id FROM users LIMIT 1').get() });
      }
      if (method === 'GET' && url.pathname === '/api/invitation') {
        const rawToken = url.searchParams.get('token') || '';
        if (!/^[a-f0-9]{64}$/.test(rawToken)) fail(404, 'This invitation link is invalid.');
        const invitation = db.prepare('SELECT email, expires_at FROM invitations WHERE token_hash = ? AND expires_at > ?').get(hash(rawToken), Date.now());
        if (!invitation) fail(410, 'This invitation has expired or was revoked. Ask your friend for a new link.');
        // Do not disclose the invited email to an unauthenticated visitor.
        return respond({ valid: true });
      }
      if (method === 'GET' && url.pathname === '/api/state') {
        if (!user) fail(401, 'Please sign in to view your lists.');
        return respond(snapshot(user));
      }
      if (method === 'GET' && url.pathname.startsWith('/api/files/')) {
        if (!user) fail(401, 'Please sign in to download files.');
        const file = db.prepare('SELECT * FROM shared_files WHERE id = ?').get(url.pathname.slice('/api/files/'.length));
        if (!file) fail(404, 'This file is no longer available.');
        access(user, file.list_id, 'read');
        if (file.expires_at <= Date.now()) fail(410, 'This file has expired and is no longer available.');
        let handle;
        try { handle = await open(filePath(file.id), 'r'); }
        catch (error) { if (error.code === 'ENOENT') fail(404, 'This file is no longer available.'); throw error; }
        // Access or expiry may change while the file is being opened.
        try {
          if (!sessionUser(db, request)) fail(401, 'Please sign in to download files.');
          access(user, file.list_id, 'read');
          if (file.expires_at <= Date.now() || !db.prepare('SELECT id FROM shared_files WHERE id = ?').get(file.id)) fail(410, 'This file is no longer available.');
        } catch (error) { await handle.close(); throw error; }
        const encodedName = encodeURIComponent(file.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream', 'Content-Length': file.size,
          'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodedName}`,
          'Cache-Control': 'no-store',
        });
        const stream = handle.createReadStream();
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        stream.pipe(response);
        return;
      }
      if (method === 'GET' && url.pathname === '/api/events') {
        if (!user) fail(401, 'Please sign in to view your lists.');
        const active = [...clients].filter(c => c.userId === user.id).length;
        if (active >= 10) fail(429, 'Too many open tabs. Please close a tab and try again.');
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write('retry: 3000\n\n');
        const client = { response, userId: user.id, sessionHash: hash(sessionToken(request)) };
        clients.add(client);
        broadcast();
        response.on('close', () => { clients.delete(client); broadcast(); });
        return;
      }
      if (method !== 'POST') fail(405, 'Method not allowed.');
      const expectedOrigin = configuredOrigin || `http://${request.headers.host}`;
      if ((request.headers.origin && request.headers.origin !== expectedOrigin) || request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Please make changes from Together.');
      if (url.pathname === '/api/files') {
        if (!user) fail(401, 'Please sign in to upload files.');
        const listId = text({ listId: url.searchParams.get('listId') }, 'listId', 100);
        access(user, listId);
        const name = text({ name: url.searchParams.get('name') }, 'name', 255);
        if (/[\\/\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') fail(400, 'Please use a valid file name without folders.');
        if (request.headers['content-type'] !== 'application/octet-stream') fail(415, 'Please send a file.');
        if (Number(request.headers['content-length']) > MAX_FILE_SIZE) fail(413, 'Files can be up to 100 MB.');
        const id = randomUUID();
        let handle;
        let stored = false;
        activeUploads.add(id);
        try {
          handle = await open(filePath(id), 'wx', 0o600);
          let size = 0;
          for await (const chunk of request.iterator({ destroyOnReturn: false })) {
            size += chunk.length;
            if (size > MAX_FILE_SIZE) fail(413, 'Files can be up to 100 MB.');
            await handle.writeFile(chunk);
          }
          await handle.close(); handle = null;
          // Recheck the session and list grant after a potentially long upload.
          if (!sessionUser(db, request)) fail(401, 'Please sign in to upload files.');
          access(user, listId);
          const now = Date.now();
          transaction(db, () => {
            db.prepare('INSERT INTO shared_files VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, listId, name, size, user.id, now, now + FILE_LIFETIME);
            bump();
          });
          stored = true;
          scheduleExpiry();
          broadcast();
          return respond({ ok: true, fileId: id }, 201);
        } finally {
          if (handle) await handle.close();
          activeUploads.delete(id);
          if (!stored) rmSync(filePath(id), { force: true });
          if (!request.complete) request.resume();
        }
      }
      const input = await body(request, url.pathname === '/api/sheet' ? 1200000 : 16000);

      if (url.pathname === '/api/setup' || url.pathname === '/api/register') {
        const { email, password } = credentials(input);
        rateLimit(request, email);
        const name = text(input, 'name', 60);
        const setup = url.pathname === '/api/setup';
        if (setup && db.prepare('SELECT id FROM users LIMIT 1').get()) fail(403, 'This notebook is already set up. Ask the owner for an invitation.');
        const rawToken = typeof input.invite === 'string' ? input.invite : '';
        if (!setup && !/^[a-f0-9]{64}$/.test(rawToken)) fail(403, 'You need a personal invitation to create an account.');
        const storedHash = await passwordHash(password);
        const newId = randomUUID();
        transaction(db, () => {
          if (setup && db.prepare('SELECT id FROM users LIMIT 1').get()) fail(403, 'This notebook is already set up.');
          if (!setup) {
            const invite = db.prepare('SELECT * FROM invitations WHERE token_hash = ? AND expires_at > ?').get(hash(rawToken), Date.now());
            if (!invite) fail(410, 'This invitation has expired or was revoked.');
            if (invite.email.toLowerCase() !== email) fail(403, 'Use the email address your friend invited.');
          }
          if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) fail(409, 'An account with this email already exists. Please sign in.');
          db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(newId, email, name, storedHash, setup ? 'owner' : 'member', Date.now());
          if (setup) db.prepare('INSERT INTO lists (id,title,color,created_at,owner_id) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), 'My first list', 'purple', Date.now(), newId);
          else db.prepare('DELETE FROM invitations WHERE token_hash = ?').run(hash(rawToken));
          bump();
        });
        const cookie = createSession(db, newId, secure);
        broadcast();
        return respond({ ok: true }, 201, { 'Set-Cookie': cookie });
      }
      if (url.pathname === '/api/login') {
        const { email, password } = credentials(input);
        rateLimit(request, email);
        const account = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        const correct = await checkPassword(password, account?.password_hash || dummyPassword);
        if (!account || !correct) fail(401, 'The email or password is incorrect.');
        return respond({ ok: true }, 200, { 'Set-Cookie': createSession(db, account.id, secure) });
      }
      if (!user) fail(401, 'Please sign in to view your lists.');
      if (url.pathname === '/api/logout') {
        db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash(sessionToken(request)));
        broadcast();
        return respond({ ok: true }, 200, { 'Set-Cookie': `together_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}` });
      }
      if (url.pathname === '/api/password') {
        rateLimit(request, user.email);
        const account = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
        if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 128 || !await checkPassword(input.currentPassword, account.password_hash)) fail(400, 'Your current password is incorrect.');
        const { password } = credentials({ email: user.email, password: input.password });
        const newHash = await passwordHash(password);
        transaction(db, () => {
          db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
          db.prepare('DELETE FROM sessions WHERE user_id = ? AND hash != ?').run(user.id, hash(sessionToken(request)));
        });
        broadcast();
        return respond({ ok: true });
      }
      if (!['/api/action', '/api/sheet'].includes(url.pathname)) fail(404, 'Not found.');
      const action = url.pathname === '/api/sheet' ? 'update-sheet' : text(input, 'action', 40);
      let result = { ok: true };
      transaction(db, () => {
        if (action === 'add-list') {
          const color = ['purple','green','orange','blue','pink'].includes(input.color) ? input.color : 'purple';
          const id = randomUUID();
          db.prepare('INSERT INTO lists (id,title,color,created_at,owner_id) VALUES (?, ?, ?, ?, ?)').run(id, text(input, 'title', 80), color, Date.now(), user.id);
          result.listId = id;
        } else if (action === 'share-list') {
          const listId = list(user, input, 'owner');
          const userId = text(input, 'userId', 100);
          if (userId === user.id) fail(400, 'The list owner always has full access.');
          if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) fail(404, 'This member no longer exists.');
          if (!['read', 'edit', 'none'].includes(input.permission)) fail(400, 'Choose read, edit, or none.');
          if (input.permission === 'none') db.prepare('DELETE FROM list_permissions WHERE list_id = ? AND user_id = ?').run(listId, userId);
          else db.prepare(`INSERT INTO list_permissions VALUES (?, ?, ?) ON CONFLICT(list_id, user_id)
            DO UPDATE SET permission = excluded.permission`).run(listId, userId, input.permission);
        } else if (action === 'rename-list') {
          db.prepare('UPDATE lists SET title = ? WHERE id = ?').run(text(input, 'title', 80), list(user, input));
        } else if (action === 'delete-list') {
          db.prepare('DELETE FROM lists WHERE id = ?').run(list(user, input, 'owner'));
        } else if (action === 'add-sheet') {
          const listId = list(user, input), id = randomUUID();
          const title = text(input, 'title', 80);
          db.prepare('INSERT INTO text_sheets (id,list_id,title,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, listId, title, user.id, Date.now(), Date.now());
          result.sheetId = id;
        } else if (['update-sheet', 'rename-sheet', 'delete-sheet'].includes(action)) {
          const sheet = db.prepare('SELECT * FROM text_sheets WHERE id = ?').get(text(input, 'sheetId', 100));
          if (!sheet) fail(404, 'This text sheet no longer exists. Your local draft has been kept.');
          access(user, sheet.list_id);
          if (action === 'rename-sheet') db.prepare('UPDATE text_sheets SET title = ? WHERE id = ?').run(text(input, 'title', 80), sheet.id);
          else if (action === 'delete-sheet') {
            if (input.version !== sheet.version) fail(409, 'This sheet has changed. Please review it before deleting.');
            db.prepare('DELETE FROM text_sheets WHERE id = ?').run(sheet.id);
          } else {
            if (!Number.isInteger(input.version) || input.version < 0 || input.version > sheet.version) fail(400, 'Invalid text version.');
            const operationId = text(input, 'operationId', 100);
            const existing = db.prepare('SELECT sheet_id, version FROM text_changes WHERE operation_id = ?').get(operationId);
            if (existing && (existing.sheet_id !== sheet.id || existing.version <= input.version)) fail(409, 'Invalid save identifier.');
            if (!existing) {
              let operation = input.operation;
              try {
                operationLengths(operation);
                for (const change of sheetSnapshot(sheet, input.version).changes) operation = transformOperations(operation, change.operation)[0];
                const content = applyOperation(sheet.content, operation);
                db.prepare('UPDATE text_sheets SET content=?, version=version+1, updated_by=?, updated_at=? WHERE id=?').run(content, user.id, Date.now(), sheet.id);
                db.prepare('INSERT INTO text_changes VALUES (?,?,?,?)').run(sheet.id, sheet.version + 1, operationId, JSON.stringify(operation));
              } catch (error) {
                if (error instanceof HttpError) throw error;
                fail(400, error.message);
              }
            }
            result.sheet = sheetSnapshot(db.prepare('SELECT * FROM text_sheets WHERE id = ?').get(sheet.id), input.version);
          }
        } else if (action === 'set-file-expiry') {
          const file = db.prepare('SELECT * FROM shared_files WHERE id = ?').get(text(input, 'fileId', 100));
          if (!file) fail(404, 'This file is no longer available.');
          access(user, file.list_id);
          const now = Date.now();
          if (file.expires_at <= now) fail(410, 'This file has already expired.');
          if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > MAX_FILE_LIFETIME_MINUTES) fail(400, 'Choose a deletion time between 1 minute and 30 days.');
          db.prepare('UPDATE shared_files SET expires_at = ? WHERE id = ?').run(now + input.minutes * 60000, file.id);
        } else if (action === 'delete-file') {
          const file = db.prepare('SELECT * FROM shared_files WHERE id = ?').get(text(input, 'fileId', 100));
          if (!file) fail(404, 'This file is no longer available.');
          access(user, file.list_id);
          rmSync(filePath(file.id), { force: true });
          db.prepare('DELETE FROM shared_files WHERE id = ?').run(file.id);
        } else if (action === 'add-task') {
          const listId = list(user, input);
          db.prepare('INSERT INTO tasks (id,list_id,text,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), listId, text(input, 'text', 300), user.id, Date.now(), Date.now());
        } else if (action === 'update-task' || action === 'delete-task') {
          const taskId = text(input, 'taskId', 100);
          const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
          if (!task) fail(404, 'This task no longer exists.');
          access(user, task.list_id);
          if (!Number.isInteger(input.version) || input.version !== task.version) fail(409, 'Your friend just changed this task. The list has been refreshed; please try again.');
          if (action === 'delete-task') db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
          else {
            const taskText = input.text === undefined ? task.text : text(input, 'text', 300);
            const note = input.note === undefined ? task.note : typeof input.note === 'string' && input.note.length <= 2000 ? input.note.trim() : null;
            if (note === null || (input.done !== undefined && typeof input.done !== 'boolean')) fail(400, 'Please enter a valid task.');
            const done = input.done === undefined ? task.done : input.done ? 1 : 0;
            db.prepare('UPDATE tasks SET text=?, note=?, done=?, version=version+1, updated_by=?, updated_at=? WHERE id=?').run(taskText, note, done, user.id, Date.now(), taskId);
          }
        } else if (action === 'complete-list') {
          db.prepare('UPDATE tasks SET done=1, version=version+1, updated_by=?, updated_at=? WHERE list_id=? AND done=0').run(user.id, Date.now(), list(user, input));
        } else if (action === 'rename-notebook') {
          ownerOnly(user);
          db.prepare("UPDATE settings SET value = ? WHERE key = 'name'").run(text(input, 'title', 80));
        } else if (action === 'invite') {
          ownerOnly(user);
          const email = text(input, 'email', 254).toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email address.');
          if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) fail(409, 'That person already belongs to this notebook.');
          const rawToken = token();
          db.prepare('DELETE FROM invitations WHERE email = ?').run(email);
          db.prepare('INSERT INTO invitations VALUES (?, ?, ?, ?, ?)').run(randomUUID(), email, hash(rawToken), Date.now() + 7 * 86400000, Date.now());
          result = { ok: true, invitePath: '/?invite=' + rawToken, email };
        } else if (action === 'revoke-invite') {
          ownerOnly(user);
          db.prepare('DELETE FROM invitations WHERE id = ?').run(text(input, 'inviteId', 100));
        } else if (action === 'remove-member') {
          ownerOnly(user);
          const id = text(input, 'userId', 100);
          if (id === user.id) fail(400, 'The owner cannot be removed.');
          if (db.prepare('SELECT id FROM lists WHERE owner_id = ? LIMIT 1').get(id)) fail(409, 'This member owns lists. Ask them to delete their lists before removing their account.');
          db.prepare('DELETE FROM invitations WHERE email IN (SELECT email FROM users WHERE id = ?)').run(id);
          db.prepare("DELETE FROM users WHERE id = ? AND role != 'owner'").run(id);
        } else fail(400, 'Unknown action.');
        bump();
      });
      if (action === 'delete-list') cleanupFiles();
      if (action === 'set-file-expiry') scheduleExpiry();
      broadcast();
      return respond(result);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Request failed:', error);
      if (!response.headersSent) respond({ error: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.' }, error.status || 500);
      else response.end();
    }
  });
  const maintenance = setInterval(() => {
    for (const [key, entry] of attempts) if (entry.until < Date.now()) attempts.delete(key);
    for (const client of clients) {
      if (!validClient(client)) { clients.delete(client); client.response.end(); }
      else client.response.write(': keep-alive\n\n');
    }
  }, 25000);
  maintenance.unref();
  server.requestTimeout = 300000;
  server.headersTimeout = 15000;
  return {
    server, db,
    async close() {
      closing = true;
      clearTimeout(expiryTimer);
      clearInterval(maintenance);
      for (const client of clients) client.response.end();
      clients.clear();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
      if (database === ':memory:') {
        for (const name of readdirSync(uploadDirectory)) rmSync(filePath(name), { force: true });
        rmdirSync(uploadDirectory);
      }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '0.0.0.0', () => console.log(`Together is ready on port ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
