# Implementation plan

1. **Design and scaffold** — create the Tauri/React project, security documents, restrictive capabilities, and encrypted vault lifecycle.
2. **Vault core** — add password creation/unlock/lock, authenticated encrypted persistence, and tests for wrong passwords and tampering.
3. **Notes** — add transactional note CRUD, Markdown editing, folders, tags, pin/archive/trash, and local in-memory search.
4. **UX** — add the three-pane workspace, keyboard shortcuts, appearance settings, accessible states, and inactivity locking.
5. **Recovery** — add versioned encrypted backups, safe restore, password change via wrapped vault key, and recovery tests.
6. **Hardening** — validate dependencies, audit logs and auxiliary files, add migrations, package macOS builds, and document exact limitations.

The current implementation covers the scaffold, encrypted vault lifecycle, SQLCipher-backed note persistence with schema migration, organization metadata, soft-delete trash, password change with database rekey, unified encrypted backup/restore containers, native file pickers, renderer inactivity locking, native resume/exit locking, and Rust crypto/database tests. Cross-platform SQLCipher packaging and broader integration testing remain before V1.
