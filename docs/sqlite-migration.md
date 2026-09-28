# SQLite / SQLCipher migration design

The current milestone uses an authenticated encrypted JSON payload so the vault lifecycle can be exercised without committing to an unverified native SQLCipher build. The production storage milestone should use SQLCipher only after validating its native packaging on macOS.

## Target schema

All tables live inside the encrypted database. No title, folder, tag, search index, or timestamp is intentionally left in a plaintext sidecar.

```sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  folder TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE note_tags (note_id TEXT NOT NULL, tag_id TEXT NOT NULL,
  PRIMARY KEY (note_id, tag_id),
  FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE);
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

## Migration rules

1. Open the database only after successful key derivation and SQLCipher key setup.
2. Run migrations in a transaction and update `schema_meta` only after the transaction commits.
3. Keep the old encrypted envelope available until the new database passes integrity checking.
4. Never create a persistent plaintext FTS index. Search the decrypted connection while unlocked, or use an encrypted index inside the database after a separate review.
5. Test interrupted migrations by copying the vault before each migration and reopening both the original and recovery copy.
