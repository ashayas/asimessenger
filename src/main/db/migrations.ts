/** Append-only list. Never edit a shipped migration; add a new one. */
export const MIGRATIONS: string[] = [
  /* 1: core schema */
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
    slot INTEGER UNIQUE, color TEXT, layout_json TEXT
  );
  CREATE TABLE friends (
    id TEXT PRIMARY KEY, harness TEXT NOT NULL, display_name TEXT NOT NULL, avatar TEXT,
    command TEXT, args_json TEXT NOT NULL DEFAULT '[]', transport TEXT,
    default_mode TEXT NOT NULL DEFAULT 'ask', dangerous_allowed INTEGER NOT NULL DEFAULT 0,
    lettering_style TEXT NOT NULL DEFAULT 'funky', secret_ref TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT);
  CREATE TABLE friend_labels (
    friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (friend_id, label_id)
  );
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
    title TEXT NOT NULL, harness_session_id TEXT, status TEXT NOT NULL DEFAULT 'online',
    unread_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
    window_state_json TEXT
  );
  CREATE INDEX chats_workspace ON chats(workspace_id, last_activity_at DESC);
  CREATE TABLE chat_labels (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (chat_id, label_id)
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL, kind TEXT NOT NULL, body_json TEXT NOT NULL, text TEXT,
    created_at INTEGER NOT NULL, read_at INTEGER
  );
  CREATE INDEX messages_chat ON messages(chat_id, created_at);
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, name TEXT NOT NULL, path TEXT, sha256 TEXT, body TEXT
  );
  CREATE TABLE permission_requests (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    tool TEXT NOT NULL, summary TEXT NOT NULL, risk TEXT, decision TEXT, decided_by TEXT, decided_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE drawings (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    path TEXT NOT NULL, title TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE transcribe_models (
    id TEXT PRIMARY KEY, engine TEXT NOT NULL, name TEXT NOT NULL, path TEXT, bytes INTEGER,
    status TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  `,
  /* 2: full-text search kept current by triggers */
  `
  CREATE VIRTUAL TABLE search_fts USING fts5(
    kind UNINDEXED, ref_id UNINDEXED, workspace_id UNINDEXED, title, body, tokenize = 'unicode61'
  );

  CREATE TRIGGER friends_ai AFTER INSERT ON friends BEGIN
    INSERT INTO search_fts(kind, ref_id, workspace_id, title, body) VALUES ('friend', new.id, NULL, new.display_name, '');
  END;
  CREATE TRIGGER friends_au AFTER UPDATE OF display_name ON friends BEGIN
    UPDATE search_fts SET title = new.display_name WHERE kind = 'friend' AND ref_id = new.id;
  END;
  CREATE TRIGGER friends_ad AFTER DELETE ON friends BEGIN
    DELETE FROM search_fts WHERE kind = 'friend' AND ref_id = old.id;
  END;

  CREATE TRIGGER chats_ai AFTER INSERT ON chats BEGIN
    INSERT INTO search_fts(kind, ref_id, workspace_id, title, body) VALUES ('chat', new.id, new.workspace_id, new.title, '');
  END;
  CREATE TRIGGER chats_au AFTER UPDATE OF title ON chats BEGIN
    UPDATE search_fts SET title = new.title WHERE kind = 'chat' AND ref_id = new.id;
  END;
  CREATE TRIGGER chats_ad AFTER DELETE ON chats BEGIN
    DELETE FROM search_fts WHERE kind = 'chat' AND ref_id = old.id;
  END;

  CREATE TRIGGER messages_ai AFTER INSERT ON messages WHEN new.text IS NOT NULL AND new.text <> '' BEGIN
    INSERT INTO search_fts(kind, ref_id, workspace_id, title, body)
    SELECT 'message', new.id, c.workspace_id, c.title, new.text FROM chats c WHERE c.id = new.chat_id;
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    DELETE FROM search_fts WHERE kind = 'message' AND ref_id = old.id;
  END;

  CREATE TRIGGER attachments_ai AFTER INSERT ON attachments BEGIN
    INSERT INTO search_fts(kind, ref_id, workspace_id, title, body)
    SELECT 'attachment', new.id, c.workspace_id, new.name, COALESCE(new.body, '')
    FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = new.message_id;
  END;
  CREATE TRIGGER attachments_ad AFTER DELETE ON attachments BEGIN
    DELETE FROM search_fts WHERE kind = 'attachment' AND ref_id = old.id;
  END;

  CREATE TRIGGER drawings_ai AFTER INSERT ON drawings BEGIN
    INSERT INTO search_fts(kind, ref_id, workspace_id, title, body) VALUES ('drawing', new.id, new.workspace_id, new.title, '');
  END;
  CREATE TRIGGER drawings_ad AFTER DELETE ON drawings BEGIN
    DELETE FROM search_fts WHERE kind = 'drawing' AND ref_id = old.id;
  END;
  `,
  /* 3: live status text shown as the "personal message" */
  `ALTER TABLE chats ADD COLUMN status_text TEXT;`,
  /* 4: keep the search index current when a streamed message's text changes */
  `
  CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
    DELETE FROM search_fts WHERE kind = 'message' AND ref_id = old.id;
    INSERT INTO search_fts(kind, ref_id, workspace_id, title, body)
    SELECT 'message', new.id, c.workspace_id, c.title, new.text FROM chats c WHERE c.id = new.chat_id AND new.text IS NOT NULL AND new.text <> '';
  END;
  `
]
