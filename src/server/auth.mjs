import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const sessionDuration = 14 * 86400000;
export const token = () => randomBytes(32).toString('hex');
export const hash = (text) => createHash('sha256').update(text).digest('hex');

export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt}:${key.toString('hex')}`;
}

export async function checkPassword(password, stored) {
  const [salt, encoded] = stored.split(':');
  const expected = Buffer.from(encoded, 'hex');
  const actual = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sessionToken(request) {
  return (request.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('together_session='))?.slice(17) || '';
}

export function sessionUser(db, request) {
  const rawToken = sessionToken(request);
  if (!/^[a-f0-9]{64}$/.test(rawToken)) return null;
  return db.prepare(`SELECT u.id, u.email, u.name, u.role FROM users u
    JOIN sessions s ON s.user_id = u.id WHERE s.hash = ? AND s.expires_at > ?`).get(hash(rawToken), Date.now()) || null;
}

export function createSession(db, userId, secure) {
  const rawToken = token();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(rawToken), userId, Date.now() + sessionDuration);
  return `together_session=${rawToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionDuration / 1000}${secure ? '; Secure' : ''}`;
}
