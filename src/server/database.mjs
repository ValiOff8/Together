import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','member')), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, color TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      text TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS text_sheets (
      id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS text_changes (
      sheet_id TEXT NOT NULL REFERENCES text_sheets(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, operation_id TEXT NOT NULL UNIQUE,
      operation TEXT NOT NULL, PRIMARY KEY (sheet_id, version)
    );
    CREATE TABLE IF NOT EXISTS shared_files (
      id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      name TEXT NOT NULL, size INTEGER NOT NULL, uploaded_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shared_files_expiry ON shared_files(expires_at);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES ('name', 'Our notebook');
    INSERT OR IGNORE INTO settings VALUES ('revision', '0');
  `);
  transaction(db, () => {
    const legacy = !db.prepare('PRAGMA table_info(lists)').all().some(column => column.name === 'owner_id');
    if (legacy) db.exec('ALTER TABLE lists ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE RESTRICT');
    db.exec(`CREATE TABLE IF NOT EXISTS list_permissions (
      list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL CHECK(permission IN ('read','edit')),
      PRIMARY KEY (list_id, user_id)
    )`);
    if (legacy) {
      db.exec(`UPDATE lists SET owner_id = (SELECT id FROM users WHERE role = 'owner' LIMIT 1);
        INSERT INTO list_permissions (list_id, user_id, permission)
        SELECT l.id, u.id, 'edit' FROM lists l CROSS JOIN users u WHERE u.id != l.owner_id;`);
    }
    db.exec('PRAGMA user_version = 4');
  });
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
