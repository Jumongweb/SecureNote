# Architecture

## Scope of this milestone

This repository started as a specification-only project. The first implementation milestone establishes a working offline Tauri application and an encrypted single-vault persistence core. It intentionally does not yet claim production security or complete the final SQLCipher-backed schema.

## Components

- **Renderer:** React and TypeScript. It owns presentation and transient UI state only.
- **Native layer:** Rust commands exposed through Tauri. It owns vault files, password-derived keys, encryption, and persistence.
- **Vault file:** A versioned binary envelope containing an Argon2id salt, KDF parameters, a random nonce, and an XChaCha20-Poly1305 ciphertext. Plaintext note data is serialized only inside the authenticated ciphertext.

The renderer temporarily holds the master password typed into the authentication form and sends it to a narrow Rust command over Tauri IPC. It never receives the derived key, SQLCipher key, biometric data, nonce, or vault file contents. Authentication input is cleared after unlock or lock.

Backup creation and restore use the Tauri native dialog plugin. The renderer receives only the user-selected path and operation result; file contents remain in Rust.

## Planned evolution

The active persistence layer now includes a bundled SQLCipher database at `vault.db`, protected by a random vault data key. The password-derived wrapping key protects that data key, while the authenticated envelope retains the wrapped key and migration/recovery metadata. The IPC surface remains stable so the UI is not coupled to the database choice.

## State model

The UI represents `not-created`, `locked`, `unlocking`, `unlocked`, `locking`, and `error`. Rust keeps the currently unlocked vault in memory only for the command session and clears it on explicit lock where practical.

## Current implementation additions

Notes now carry optional folder and tag metadata plus pinned, archived, and trash state. Trash is soft-delete by default; permanent deletion is a separate command. Backups are versioned `.snvb` containers containing the authenticated vault header and SQLCipher database, protected by an outer authenticated envelope.

The UI enforces a five-minute inactivity lock for the current milestone. Rust also clears unlocked state on resume and process exit.

User-adjustable auto-lock duration, theme, typography and layout preferences are stored locally in renderer preferences; they contain no vault content or key material. The configured automatic-backup path is also a renderer preference and is therefore unencrypted metadata.

Encrypted SQLCipher tables also contain bounded note revision history, attachment blobs, and saved searches. Attachment previews cross IPC as in-memory base64 and are never intentionally written to a temporary plaintext preview file. Plain Markdown export is an explicit user action; `.snshare` exports use a separately password-derived authenticated-encryption key.

An optional recovery envelope wraps the random vault data key with a key derived from a 256-bit recovery code. The code is shown once and is not persisted. Recovery rewrites only the password wrapper and disables convenience unlocks. Backup restore removes quick-unlock and recovery wrappers that may refer to a different data key.

## Current deviations

- SQLCipher is bundled through `rusqlite` and the database has a versioned schema migration table. Cross-platform packaging still needs validation on Windows/Linux.
- The encrypted envelope remains duplicated inside the active vault and backup container for recovery compatibility.
- Backup and restore use native file pickers and restore confirms replacement in the UI before invoking Rust.
- The current key hierarchy rewraps the random vault data key during password changes; it does not rekey the SQLCipher database.
