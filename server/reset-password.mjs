import { emitKeypressEvents } from 'node:readline';
import { openDatabase, transaction } from './database.mjs';
import { passwordHash } from './auth.mjs';

if (!process.stdin.isTTY || !process.argv[2]) {
  console.error('Usage: docker compose exec -it together node server/reset-password.mjs EMAIL');
  process.exit(1);
}
const db = openDatabase(process.env.DATABASE_PATH || './data/together.sqlite');
const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(process.argv[2].trim().toLowerCase());
if (!user) { console.error('No account found with that email.'); db.close(); process.exit(1); }

async function readPassword(prompt) {
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error) {
      process.stdin.off('keypress', keypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      error ? reject(error) : resolve(value);
    }
    function keypress(str, key = {}) {
      if (key.ctrl && key.name === 'c') return finish(new Error('Cancelled.'));
      if (key.name === 'return') return finish();
      if (key.name === 'backspace') value = value.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) value += str;
    }
    process.stdin.on('keypress', keypress);
    process.stdin.resume();
  });
}
try {
  const password = await readPassword(`New password for ${user.email} (input hidden): `);
  if (password.length < 10 || password.length > 128) throw new Error('Use a password with 10 to 128 characters.');
  if (password !== await readPassword('Repeat new password: ')) throw new Error('The passwords do not match.');
  const encoded = await passwordHash(password);
  transaction(db, () => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(encoded, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  });
  console.log('Password updated. All existing sessions for this account were signed out.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db.close(); }
