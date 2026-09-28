# Security review — September 2026

## Verified architecture

- Vault persistence uses SQLCipher with a random 256-bit data key. The master password is processed by native Rust with Argon2id and protects the data key through an authenticated XChaCha20-Poly1305 wrapper.
- Password, PIN, recovery-key and Touch ID operations are native commands. The React renderer temporarily holds user-entered authentication text so it can invoke those commands, but it never receives derived keys, the SQLCipher key or biometric data.
- Touch ID key material is stored in macOS Keychain with `biometryCurrentSet`. PIN unlock protects the same key material with an Argon2id-derived key, but a six-digit PIN remains susceptible to offline guessing and is convenience access only.
- The active Tauri capability grants the main window core window operations and native dialogs. It does not grant general filesystem, shell or network APIs. The CSP limits connections to Tauri IPC.
- Credential-card values are masked, automatically remasked, omitted from previews and excluded from local intelligence. Clipboard secrets are cleared after 30 seconds only if the clipboard still contains the copied value.
- Attachments remain encrypted in SQLCipher. Previews cross IPC in memory. Plaintext files are created only after an explicit export action and warning.
- Backup restoration authenticates the backup before replacement and invalidates quick-unlock/recovery wrappers that may reference a different data key.
- Explicit lock, inactivity lock, system resume and process exit invalidate native unlocked state. React also drops decrypted notes, previews, OCR, intelligence results, authentication fields and revealed credential state.
- No source logging calls write note text, credential values, passwords or keys.

## Privacy boundaries

Private Intelligence is an in-process extractive ranker, not an LLM. It performs no network request, has no cloud fallback and excludes credential content. Its UI now reports the actual engine and processing state rather than implying that a model is loaded.

Native task notifications contain only a generic message and due time. Note titles and task text are not submitted to macOS notification content.

Renderer `localStorage` contains appearance/layout/auto-lock preferences and the chosen automatic-backup path. It does not contain notes, passwords or encryption keys. The backup path is unencrypted filesystem metadata and should not be treated as confidential.

## Remaining limitations

- This is not an independent security audit. Dependency compromise, implementation defects and platform vulnerabilities remain possible.
- A compromised operating system, accessibility tool, debugger or malicious process can capture plaintext, keystrokes, screenshots or process memory while the vault is unlocked.
- Clearing Rust and React state reduces continued access but cannot guarantee secure erasure of every compiler, WebKit, allocator, swap or crash-report copy.
- PIN unlock has only one million possible values. Runtime throttling helps interactive attacks but cannot prevent offline guessing against a copied PIN wrapper.
- User-requested Markdown exports and exported attachments are plaintext outside the vault. The application cannot control their protection afterward.
- Development-signed builds are suitable for local testing but are not notarized for public distribution.
- Touch ID interaction requires a signed macOS application and physical macOS UI automation; it is not exercised by the headless unit-test suite.

## Review actions completed

- Preserved the vault envelope and SQLCipher schema.
- Kept authentication authorization in Rust rather than using renderer visibility as authentication.
- Added explicit authentication waiting/failure/cancellation UI states.
- Added failed-save state so the interface never labels a rejected persistence operation as saved.
- Kept credential values out of Markdown preview, semantic ranking, summaries, related-note excerpts and notifications.
- Retained the minimal Tauri permissions and restrictive CSP.
