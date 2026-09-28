use rusqlite::{params, Connection};
use std::path::Path;

use crate::{Attachment, Note, NoteVersion, SavedSearch, VaultError};

fn key_hex(key: &[u8]) -> String {
    key.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn open(path: &Path, key: &[u8]) -> Result<Connection, VaultError> {
    let connection = Connection::open(path).map_err(|_| VaultError::Database)?;
    connection
        .pragma_update(None, "key", key_hex(key))
        .map_err(|_| VaultError::Authentication)?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|_| VaultError::Database)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| VaultError::Database)?;
    migrate(&connection)?;
    Ok(connection)
}

pub fn migrate(connection: &Connection) -> Result<(), VaultError> {
    connection.execute_batch("BEGIN;
        CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, folder TEXT, tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, deleted_at TEXT);
        CREATE TABLE IF NOT EXISTS note_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, folder TEXT, tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, saved_at TEXT NOT NULL, FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, note_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS saved_searches (id TEXT PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_note_versions_note_saved ON note_versions(note_id, saved_at DESC);
        CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id, created_at DESC);
        INSERT INTO schema_meta(key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value='2';
        COMMIT;").map_err(|_| VaultError::Database)
}

pub fn load_notes(connection: &Connection) -> Result<Vec<Note>, VaultError> {
    let mut statement = connection.prepare("SELECT id, title, content, folder, tags, created_at, updated_at, pinned, archived, deleted_at FROM notes ORDER BY updated_at DESC").map_err(|_| VaultError::Database)?;
    let rows = statement
        .query_map([], |row| {
            let tags_json: String = row.get(4)?;
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                folder: row.get(3)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                pinned: row.get(7)?,
                archived: row.get(8)?,
                deleted_at: row.get(9)?,
            })
        })
        .map_err(|_| VaultError::Database)?;
    rows.map(|row| row.map_err(|_| VaultError::Database))
        .collect()
}

pub fn save_note(connection: &Connection, note: &Note) -> Result<(), VaultError> {
    let tags = serde_json::to_string(&note.tags)?;
    connection.execute("INSERT INTO notes(id,title,content,folder,tags,created_at,updated_at,pinned,archived,deleted_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, folder=excluded.folder, tags=excluded.tags, updated_at=excluded.updated_at, pinned=excluded.pinned, archived=excluded.archived, deleted_at=excluded.deleted_at", params![note.id, note.title, note.content, note.folder, tags, note.created_at, note.updated_at, note.pinned, note.archived, note.deleted_at]).map_err(|_| VaultError::Database)?;
    Ok(())
}

pub fn note_exists(connection: &Connection, id: &str) -> bool {
    connection
        .query_row("SELECT 1 FROM notes WHERE id=?1", params![id], |_| Ok(()))
        .is_ok()
}

pub fn remove_notes_except(connection: &Connection, notes: &[Note]) -> Result<(), VaultError> {
    let mut statement = connection
        .prepare("SELECT id FROM notes")
        .map_err(|_| VaultError::Database)?;
    let ids: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .map_err(|_| VaultError::Database)?
        .filter_map(Result::ok)
        .collect();
    for id in ids {
        if !notes.iter().any(|note| note.id == id) {
            connection
                .execute("DELETE FROM notes WHERE id=?1", params![id])
                .map_err(|_| VaultError::Database)?;
        }
    }
    Ok(())
}

pub fn save_version(
    connection: &Connection,
    note: &Note,
    saved_at: &str,
) -> Result<(), VaultError> {
    let tags = serde_json::to_string(&note.tags)?;
    let latest: Option<(String, String)> = connection
        .query_row(
            "SELECT title, content FROM note_versions WHERE note_id=?1 ORDER BY id DESC LIMIT 1",
            params![note.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    if latest
        .as_ref()
        .is_some_and(|(title, content)| title == &note.title && content == &note.content)
    {
        return Ok(());
    }
    connection.execute(
        "INSERT INTO note_versions(note_id,title,content,folder,tags,created_at,saved_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![note.id, note.title, note.content, note.folder, tags, note.created_at, saved_at],
    ).map_err(|_| VaultError::Database)?;
    connection.execute(
        "DELETE FROM note_versions WHERE note_id=?1 AND id NOT IN (SELECT id FROM note_versions WHERE note_id=?1 ORDER BY id DESC LIMIT 30)",
        params![note.id],
    ).map_err(|_| VaultError::Database)?;
    Ok(())
}

pub fn load_versions(
    connection: &Connection,
    note_id: &str,
) -> Result<Vec<NoteVersion>, VaultError> {
    let mut statement = connection.prepare("SELECT id, note_id, title, content, folder, tags, created_at, saved_at FROM note_versions WHERE note_id=?1 ORDER BY id DESC").map_err(|_| VaultError::Database)?;
    let rows = statement
        .query_map(params![note_id], |row| {
            let tags_json: String = row.get(5)?;
            Ok(NoteVersion {
                id: row.get(0)?,
                note_id: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                folder: row.get(4)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                created_at: row.get(6)?,
                saved_at: row.get(7)?,
            })
        })
        .map_err(|_| VaultError::Database)?;
    rows.map(|row| row.map_err(|_| VaultError::Database))
        .collect()
}

pub fn load_version(connection: &Connection, version_id: i64) -> Result<NoteVersion, VaultError> {
    connection.query_row(
        "SELECT id, note_id, title, content, folder, tags, created_at, saved_at FROM note_versions WHERE id=?1",
        params![version_id],
        |row| {
            let tags_json: String = row.get(5)?;
            Ok(NoteVersion {
                id: row.get(0)?, note_id: row.get(1)?, title: row.get(2)?, content: row.get(3)?, folder: row.get(4)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(), created_at: row.get(6)?, saved_at: row.get(7)?,
            })
        },
    ).map_err(|_| VaultError::NotFound)
}

pub fn save_attachment(
    connection: &Connection,
    attachment: &Attachment,
    data: &[u8],
) -> Result<(), VaultError> {
    connection.execute(
        "INSERT INTO attachments(id,note_id,name,mime,data,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
        params![attachment.id, attachment.note_id, attachment.name, attachment.mime, data, attachment.created_at],
    ).map_err(|_| VaultError::Database)?;
    Ok(())
}

pub fn load_attachments(
    connection: &Connection,
    note_id: &str,
) -> Result<Vec<Attachment>, VaultError> {
    let mut statement = connection.prepare("SELECT id,note_id,name,mime,length(data),created_at FROM attachments WHERE note_id=?1 ORDER BY created_at DESC").map_err(|_| VaultError::Database)?;
    let rows = statement
        .query_map(params![note_id], |row| {
            Ok(Attachment {
                id: row.get(0)?,
                note_id: row.get(1)?,
                name: row.get(2)?,
                mime: row.get(3)?,
                size: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|_| VaultError::Database)?;
    rows.map(|row| row.map_err(|_| VaultError::Database))
        .collect()
}

pub fn attachment_data(connection: &Connection, id: &str) -> Result<(String, Vec<u8>), VaultError> {
    connection
        .query_row(
            "SELECT name,data FROM attachments WHERE id=?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| VaultError::NotFound)
}

pub fn delete_attachment(connection: &Connection, id: &str) -> Result<(), VaultError> {
    let changed = connection
        .execute("DELETE FROM attachments WHERE id=?1", params![id])
        .map_err(|_| VaultError::Database)?;
    if changed == 0 {
        return Err(VaultError::NotFound);
    }
    Ok(())
}

pub fn integrity_check(connection: &Connection) -> Result<(), VaultError> {
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| VaultError::Database)?;
    if result == "ok" {
        Ok(())
    } else {
        Err(VaultError::Database)
    }
}

pub fn attachment_count(connection: &Connection) -> Result<i64, VaultError> {
    connection
        .query_row("SELECT count(*) FROM attachments", [], |row| row.get(0))
        .map_err(|_| VaultError::Database)
}

pub fn activity_timestamps(connection: &Connection) -> Result<Vec<String>, VaultError> {
    let mut statement = connection
        .prepare(
            "SELECT updated_at FROM notes WHERE deleted_at IS NULL
             UNION ALL
             SELECT saved_at FROM note_versions
             ORDER BY 1",
        )
        .map_err(|_| VaultError::Database)?;
    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(|_| VaultError::Database)?;
    rows.map(|row| row.map_err(|_| VaultError::Database))
        .collect()
}

pub fn load_saved_searches(connection: &Connection) -> Result<Vec<SavedSearch>, VaultError> {
    let mut statement = connection
        .prepare("SELECT id,name,query FROM saved_searches ORDER BY name")
        .map_err(|_| VaultError::Database)?;
    let rows = statement
        .query_map([], |row| {
            Ok(SavedSearch {
                id: row.get(0)?,
                name: row.get(1)?,
                query: row.get(2)?,
            })
        })
        .map_err(|_| VaultError::Database)?;
    rows.map(|row| row.map_err(|_| VaultError::Database))
        .collect()
}

pub fn save_search(connection: &Connection, search: &SavedSearch) -> Result<(), VaultError> {
    connection.execute("INSERT INTO saved_searches(id,name,query) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,query=excluded.query", params![search.id, search.name, search.query]).map_err(|_| VaultError::Database)?;
    Ok(())
}

pub fn delete_search(connection: &Connection, id: &str) -> Result<(), VaultError> {
    connection
        .execute("DELETE FROM saved_searches WHERE id=?1", params![id])
        .map_err(|_| VaultError::Database)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn database_pages_do_not_expose_note_plaintext() {
        let path = std::env::temp_dir().join(format!(
            "secure-note-test-{}.db",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let connection = open(&path, &[7u8; 32]).expect("open encrypted database");
        let note = Note {
            id: "id".into(),
            title: "secret title".into(),
            content: "secret database content".into(),
            folder: None,
            tags: vec!["private".into()],
            created_at: "1".into(),
            updated_at: "1".into(),
            pinned: false,
            archived: false,
            deleted_at: None,
        };
        save_note(&connection, &note).expect("save note");
        save_version(&connection, &note, "2").expect("save version");
        assert_eq!(activity_timestamps(&connection).expect("activity").len(), 2);
        assert_eq!(
            load_versions(&connection, &note.id)
                .expect("load versions")
                .len(),
            1
        );
        let attachment = Attachment {
            id: "file-1".into(),
            note_id: note.id.clone(),
            name: "secret.txt".into(),
            mime: "text/plain".into(),
            size: 18,
            created_at: "2".into(),
        };
        save_attachment(&connection, &attachment, b"attachment secret").expect("save attachment");
        assert_eq!(
            load_attachments(&connection, &note.id)
                .expect("load attachments")
                .len(),
            1
        );
        assert_eq!(
            attachment_data(&connection, &attachment.id)
                .expect("attachment data")
                .1,
            b"attachment secret"
        );
        let search = SavedSearch {
            id: "search-1".into(),
            name: "Pinned secrets".into(),
            query: "is:pinned tag:private".into(),
        };
        save_search(&connection, &search).expect("save search");
        assert_eq!(
            load_saved_searches(&connection).expect("load searches")[0].query,
            search.query
        );
        drop(connection);
        let bytes = fs::read(&path).expect("read database file");
        assert!(!String::from_utf8_lossy(&bytes).contains("secret database content"));
        assert!(!String::from_utf8_lossy(&bytes).contains("attachment secret"));
        assert!(!String::from_utf8_lossy(&bytes).contains("Pinned secrets"));
        fs::remove_file(path).expect("remove test database");
    }
}
