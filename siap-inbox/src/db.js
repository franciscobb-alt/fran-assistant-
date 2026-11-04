const { DatabaseSync } = require("node:sqlite");

function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE
    );

    -- one row per person per channel identity (WhatsApp number today, IG/email later)
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (channel, external_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed')),
      assignee_id INTEGER REFERENCES agents(id),
      unread INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT,
      last_inbound_at TEXT,
      last_preview TEXT,
      UNIQUE (contact_id, channel)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_list ON conversations(status, last_message_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      body TEXT,
      type TEXT NOT NULL DEFAULT 'text',
      external_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'received',
      sent_by INTEGER REFERENCES agents(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      agent_id INTEGER REFERENCES agents(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_tags (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      tag TEXT NOT NULL,
      PRIMARY KEY (conversation_id, tag)
    );
  `);
  return db;
}

module.exports = { openDb };
