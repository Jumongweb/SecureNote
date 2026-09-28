# Personal Secure Notes Vault
**Product Requirements Document (PRD)**  
**Status:** Proposed | **Version:** 1.0 | **Original date:** 31 August 2026

A local-first desktop notes application designed for storing sensitive personal information without requiring a cloud account or a continuously connected backend. The product is designed around a strong privacy model: the user's notes remain on the user's computer and are protected by encryption and a master password.

## 1. Executive Summary

The Personal Secure Notes Vault is a private desktop application for creating, organizing, searching, and storing sensitive notes. Unlike conventional cloud-first note applications, the first release will operate entirely locally. There will be no application server, remote database, or required cloud account.

Security is a primary product requirement rather than an optional feature. The application will use an encrypted local database, password-derived cryptographic keys, automatic locking, encrypted backups, and a deliberately minimized attack surface.

## 2. Product Vision

Vision: Build a fast, beautiful, private personal vault for notes where sensitive information is controlled by the user rather than stored in plaintext on third-party infrastructure.

Core principle: Privacy by architecture. The safest remote server is the one the application does not need for its core operation.

## 3. Goals and Non-Goals

    Goals                                                            Non-Goals for V1
    Store sensitive notes securely on the user's laptop.             Cloud synchronization.
    Encrypt stored note data at rest.                                Multi-user accounts.
    Provide a simple, fast notes experience.                         Team collaboration.
    Support folders, tags, favorites and search.                     Web application.
    Automatically lock after inactivity.                             Native mobile applications.
    Create encrypted backups and restore them.                       Complex enterprise administration.
## 4. Target Users

Primary user: a single technically capable individual who wants a private place to store credentials, API notes, recovery information, personal records, project notes, and other sensitive text without depending on a third-party notes provider.

V1 operating model: single local user / single vault. The architecture should avoid unnecessary multi-user complexity while leaving room for future encrypted synchronization.

## 5. User Stories

- As a user, I want to create a vault protected by a master password so that unauthorized people cannot open it.

- As a user, I want to create and edit notes quickly so that the application feels like a normal notes app.

- As a user, I want to organize notes into folders and tags so that I can retrieve information easily.

- As a user, I want to search my notes so that I can find information without manually browsing folders.

- As a user, I want the application to lock automatically after inactivity so that an unattended laptop does not expose my notes.

- As a user, I want to manually lock the vault at any time.

- As a user, I want to export an encrypted backup so that hardware failure does not permanently destroy my notes.

- As a user, I want to restore an encrypted backup using my master password.

- As a user, I want changing my master password to re-protect the vault without exposing note contents.

- As a user, I want the application to work without an internet connection.

## 6. Functional Requirements

### 6.1 Vault and Authentication

- First launch must guide the user through vault creation and master-password setup.

- The master password must never be stored as plaintext.

- The vault must be locked when the application starts unless the user has explicitly configured an acceptable secure unlock mechanism.

- Failed unlock attempts should be handled without revealing whether particular cryptographic values are correct.

- The user must be able to lock the vault manually.

- The application must support configurable automatic locking after inactivity.

- Changing the master password must require successful authentication with the current password.

### 6.2 Notes

- Create, read, edit, save and delete notes.

- Notes should support Markdown or a structured rich-text representation.

- Each note should have a title, content, created timestamp and updated timestamp.

- Notes may have tags, a folder, pinned status and archived status.

- Deleted notes should enter a trash state before permanent deletion.

### 6.3 Organization

- Folders may contain notes.

- Tags may be attached to multiple notes.

- Users can filter by folder, tag, pinned state and archive state.

- A favorites/pinned view should provide fast access to important notes.

### 6.4 Search

- Search should be fast enough for a personal vault containing thousands of notes.

- Search must not leak plaintext note content to external services.

- The implementation must explicitly document the privacy implications of any local search index.

- If an encrypted full-text index is not practical for V1, search may operate after the vault is unlocked and decrypted content is available.

### 6.5 Backup and Restore

- The user can create an encrypted vault backup.

- The backup must contain everything necessary to restore the vault, except the secret required to decrypt it.

- The user can select a backup and restore it after authentication.

- The application must warn users that losing the master password may make encrypted data unrecoverable.

- Backups should be versioned and integrity-protected.

### 6.6 Import and Export

- V1 may support plain Markdown export as an explicit user action.

- Plaintext export must be clearly labeled as sensitive and must not be presented as a secure backup.

- Encrypted backup is the preferred recovery mechanism.

- Import/export formats should be designed so the user is not trapped in the application.

## 7. Security Requirements

Security is the defining requirement of the product. The implementation must favor established cryptographic primitives and well-reviewed libraries over custom cryptography.

- Local-first: V1 core functionality must not require a remote server.

- Encryption at rest: The vault database must be encrypted so copying the database file does not reveal note contents.

- Key derivation: Use a memory-hard password KDF such as Argon2id with a unique random salt.

- Authenticated encryption: Use an established AEAD construction such as AES-256-GCM or XChaCha20-Poly1305, selected and implemented through a reputable cryptographic library.

- No custom crypto: Do not invent encryption algorithms, password hashing schemes, key derivation schemes, or authentication protocols.

- Key handling: Encryption keys should exist in application memory only when needed and should not be logged.

- Secrets in logs: Application logs must never contain note content, passwords, encryption keys, tokens, or sensitive database values.

- IPC boundary: Renderer/UI code must not receive unnecessary filesystem or database privileges. Sensitive operations should be exposed through narrowly scoped Tauri commands.

- Auto-lock: Locking must invalidate or discard active key material where practical.

- Database integrity: Tampering with encrypted data should be detected rather than silently producing corrupted plaintext.

- Dependency security: Keep Rust, frontend and native dependencies updated and audit dependencies periodically.

- Threat-model transparency: Documentation must explicitly state that an attacker controlling an already-unlocked, malware-infected operating system may be able to access plaintext while the vault is open.

## 8. Proposed Technical Architecture

The application will use a desktop-native architecture with a web-based UI and a privileged native layer. React + TypeScript → Tauri IPC → Rust security/data layer → encrypted SQLite/SQLCipher storage

    Component               Proposed Technology            Responsibility
    Desktop shell           Tauri 2                        Application lifecycle, native integration and secure IPC.
    UI                      React + TypeScript             Notes interface, editor, navigation and user interactions.
    Styling                 Tailwind CSS + shadcn/ui       Consistent desktop UI and components.
    Native layer            Rust                           Security-sensitive operations, database access and filesystem operations.
    Database                SQLite + SQLCipher             Local structured encrypted storage.
    Password KDF            Argon2id                       Derive cryptographic key material from the master password.
    Encryption              AEAD primitive                 Confidentiality and integrity for protected data.
## 9. Data Model

The initial schema should remain small and migration-friendly. A conceptual model is: Vault → Notes → Folders / Tags → Metadata Notes: id, title, content, folder_id, created_at, updated_at, pinned, archived, deleted_at Folders: id, name, created_at Tags: id, name NoteTags: note_id, tag_id

The final schema should be reviewed against the chosen encryption strategy. In particular, metadata such as titles, filenames, tags and timestamps may itself reveal sensitive information and should not automatically be assumed safe to leave unencrypted.

## 10. UX Requirements

- The application should open directly into the unlock screen.

- Unlocking should feel fast while using a sufficiently expensive password KDF.

- The main workspace should use a three-area desktop layout: navigation, note list, and editor.

- Keyboard-first interaction should be supported for common actions.

- The UI should clearly communicate Locked vs Unlocked state.

- Dangerous operations such as permanent deletion and plaintext export require confirmation.

- The application should remain usable without internet access.

- The design should prioritize simplicity over feature count.

## 11. Proposed Screens

    Screen                        Purpose
    Create Vault                  Create the local vault and set the master password.
    Unlock Vault                  Authenticate and unlock the encrypted vault.
    Home / Notes                  Browse notes, folders, tags, favorites and archive.
    Note Editor                   Create and edit note content.
    Search                        Search and filter local notes.
    Settings                      Auto-lock, appearance, backup, password change and security options.
    Backup / Restore              Create and restore encrypted vault backups.
    Trash                         Review and permanently delete notes.
## 12. Performance Requirements

- Cold startup should target under 2 seconds on a modern laptop, excluding OS or disk delays.

- Unlock should normally complete within a few seconds, with password KDF cost tuned for the target hardware.

- Opening and editing ordinary notes should feel immediate.

- Search should remain responsive with at least 10,000 notes as a V1 performance target.

- The application should have low idle CPU and memory usage.

## 13. Reliability Requirements

- Saving a note must be atomic or otherwise resistant to partial writes.

- Unexpected application termination must not normally corrupt the entire vault.

- Database migrations must be versioned.

- Backup creation should verify that the resulting backup is readable/integrity-valid.

- Restore operations should never overwrite the active vault without explicit confirmation.

## 14. Threat Model

    Threat                                             Mitigation / Boundary
    Someone copies the vault database.                 Database encryption and authenticated encryption.
    Someone steals an encrypted backup.                Backup encryption and password-derived protection.
Someone observes the application while unlocked. Auto-lock and manual lock; cannot fully protect against a local observer.

    Malware controls the OS while vault is unlocked.   Out of scope for full prevention; document this limitation.
    Password guessing against a stolen vault.          Argon2id with appropriate memory/time parameters and unique salt.
    Database tampering.                                Authenticated encryption / integrity verification.
    Application dependency vulnerability.              Dependency updates, audits and minimized privileges.
    Accidental deletion.                               Trash and encrypted backups.
## 15. MVP Scope

- Tauri desktop application

- React + TypeScript UI

- Rust native/security layer

- Local encrypted SQLite database

- Vault creation and unlock

- Master password + Argon2id key derivation

- Create/edit/delete notes

- Folders and tags

- Pinned notes

- Local search

- Auto-lock

- Manual lock

- Trash

- Encrypted backup and restore

- Password change

- Dark/light appearance

- Keyboard shortcuts

## 16. Future Roadmap

- Encrypted cross-device synchronization.

- Mobile companion application.

- Conflict-aware encrypted synchronization.

- OS biometric unlock where securely supported.

- Secure attachment storage.

- Encrypted image/PDF/file attachments.

- Version history for notes.

- Optional hardware security key integration.

- Advanced local search with a privacy-reviewed encrypted indexing design.

## 17. Acceptance Criteria for V1

- A newly created vault produces an encrypted database that does not expose note plaintext when copied outside the application.

- A wrong master password cannot unlock the vault.

- Correct authentication unlocks the vault and allows normal note operations.

- Locking the vault prevents note contents from being displayed until successful re-authentication.

- Automatic locking occurs according to the configured inactivity period.

- Notes survive application restart.

- The user can create an encrypted backup and successfully restore it on a clean installation.

- Changing the master password preserves all notes and prevents the old password from unlocking the newly protected vault.

- No secrets or note contents appear in application logs.

- Core note creation, editing, organization and retrieval work fully offline.

## 18. Development Principles

- Security over convenience for sensitive operations.

- Use established cryptography instead of custom implementations.

- Local-first by default.

- Least privilege: the UI receives only the capabilities it needs.

- Fail closed: errors should not silently bypass encryption or authentication.

- Explicit threat model: document what the application can and cannot protect.

- Recoverability: encrypted backups are part of the product, not an afterthought.

- Portability: the user should retain ownership of their data.

## 19. Important Security Caveats

This PRD defines a security-oriented architecture, not a guarantee that the resulting software will be secure. Correct cryptographic implementation, dependency selection, operating-system protections, secure key handling, testing, code review and ideally an independent security review are required before treating the application as a high-assurance password manager or security vault.

The product should not initially market itself as 'unhackable' or '100% secure'. A more accurate positioning is: local-first, encrypted personal notes with user-controlled storage.

## 20. Recommended Next Step

Before implementation, convert this PRD into a technical design document covering the exact vault file format, key hierarchy, encryption boundaries, SQLCipher configuration, Tauri IPC commands, database schema, backup format, auto-lock behavior, and security test plan. Only after that design is reviewed should the project skeleton be generated.

