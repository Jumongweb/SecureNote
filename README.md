# Secure Note Vault

An offline-first desktop vault for private Markdown notes.

## Current status

This is an early implementation, not a security audit or production-ready password manager. It includes a Tauri 2 / React app, SQLCipher-backed encrypted note storage, encrypted vault creation and unlock, emergency recovery keys, debounced autosave, encrypted revision history and saved searches, Markdown preview, encrypted file attachments, import/export, password-protected note sharing, templates, local intelligence and semantic ranking, Apple Vision OCR, protected credential cards, multiple workspace views, a local knowledge graph, global quick capture, an encrypted productivity Action Center, explicit/inactivity/resume locking, PIN attempt throttling, password change, backup inspection, and authenticated encrypted backups.

## Run locally

Prerequisites:

- Node.js 20+
- Rust stable
- Tauri 2 system prerequisites for macOS

Install dependencies and build the frontend:

```sh
npm install
npm run build
```

Start the desktop app with:

```sh
npm run tauri dev
```

## Security boundary

The current vault uses Argon2id and XChaCha20-Poly1305 with a versioned envelope. A random vault data key protects the SQLCipher database and note payload; the master-password-derived key only wraps that data key. Note metadata is inside encrypted storage. The renderer cannot access the filesystem directly. The master password is not persisted; the unlocked Rust state retains derived key material only until lock or process exit.

The Settings & security screen controls auto-lock duration, screen privacy, three appearance modes, password changes, and encrypted backup/restore actions. Scheduled backups run when the unlocked app is open and the configured interval has elapsed; they are not a macOS background service.

Appearance includes Cinematic Dark, Minimal Light and Focus Mode. The note-information rail can be collapsed with `Command-\`; its visibility and other non-secret interface preferences are remembered locally.

Recovery keys are random 256-bit secrets that wrap the vault data key separately from the master password. The app persists only the encrypted wrapper. A generated recovery code is shown once and must be stored outside the vault. Restoring a backup or using recovery disables PIN and Touch ID; restoring a backup also invalidates the previous recovery key because the backup may contain a different data key.

Optional quick unlock is available on macOS with Touch ID and with a six-digit PIN. Touch ID stores only the encrypted key material in Keychain under the current biometric set. PIN unlock is weaker against offline guessing and should be treated as convenience access; changing the master password disables both quick-unlock methods.

## Keyboard shortcuts

- `Command-K`: open the command palette
- `Command-N`: create a note
- `Command-S`: save immediately
- `Command-F`: focus note search
- `Command-L`: lock the vault
- `Command-Shift-N`: open the global Quick Capture window while the vault is unlocked

Autosave encrypts changes after a short typing pause. Up to 30 previous versions are retained per note in the encrypted database. Attachments are limited to 25 MB each and remain inside SQLCipher storage until explicitly exported.

Normal search uses an offline meaning-aware ranker. Advanced search also accepts `tag:name`, `folder:name`, `is:pinned`, `is:archived`, `after:YYYY-MM-DD`, and `before:YYYY-MM-DD`. Saved searches are kept inside SQLCipher rather than browser preferences.

Private Intelligence runs only against notes already decrypted in the unlocked webview. Ask Your Vault produces extractive answers with linked source notes; note summaries, tag suggestions, and related-note discovery do not call a network service. On macOS, image attachments can be scanned with Apple Vision OCR in the native process. OCR output is not persisted unless the user explicitly adds it to an encrypted note.

Protected credential cards mask passwords and API keys by default, automatically remask revealed fields, omit secret content from previews and intelligence output, and clear a copied secret from the macOS clipboard after 30 seconds if it has not already been replaced. This remains an organizational convenience rather than an independently audited password manager.

List, card, Kanban, calendar and interactive graph views all operate on the same encrypted notes. Kanban stage changes are persisted as tags. The global Quick Capture shortcut opens a separate always-on-top window only while the shared native vault state is unlocked; otherwise it directs the user to authenticate in the main window.

The macOS menu-bar item can show the app, create a note while the vault is unlocked, lock the vault, or quit. Security diagnostics verify SQLCipher integrity, recovery and quick-unlock state, content counts, and the running code signature.

The Action Center gathers Markdown checklist items from non-credential notes, lets you complete them in their source note, creates quick tasks in an encrypted `Action Inbox`, and shows a 12-week activity heatmap sourced from encrypted note and revision timestamps. Add `@due(YYYY-MM-DD)` or `@due(YYYY-MM-DD HH:mm)` and optionally `@priority(high)` or `@priority(low)` to a checklist item. Future due items are scheduled as local macOS reminders; notification content is deliberately generic and contains no note title or task text.

An attacker controlling the operating system while the vault is unlocked may access plaintext in memory or on screen. The native layer clears its unlocked state on resume and exit, but this is not a complete OS-level memory protection guarantee. Losing the master password may make the vault unrecoverable. Do not use real credentials during development.

The current security findings and known limitations are documented in [`docs/security-review.md`](docs/security-review.md).

Backup and restore use native file dialogs and encrypted `.snvb` files. Restore validates the backup and asks for confirmation before replacing the active vault.
# SecureNote
