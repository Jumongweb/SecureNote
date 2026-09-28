# Threat model

## Protected assets

Note titles, Markdown content, folders, tags, timestamps, vault metadata, and the master password.

## In scope

- Someone copies the vault file while the application is locked.
- An attacker guesses passwords against a copied vault.
- Accidental corruption or tampering of the vault file.
- Plaintext leakage through application logs.
- Sleep/resume and process-exit transitions while the vault is unlocked.

## Out of scope

Malware or an attacker controlling the operating system while the vault is unlocked can inspect process memory, input, screenshots, or decrypted UI content. This application cannot provide full protection against that situation.

## Mitigations

- Argon2id with a unique random salt derives a key from the master password.
- XChaCha20-Poly1305 provides confidentiality and tamper detection.
- The renderer has no direct filesystem or database access.
- The vault starts locked and supports explicit lock.
- Rust clears the in-memory vault state on Tauri resume and process exit; the UI also has an inactivity timer.
- Vault writes flush the temporary file before atomic replacement; restore authenticates the backup before copying it into place.
- Touch ID quick unlock stores key material in macOS Keychain protected by `biometryCurrentSet`; changing the enrolled biometric set invalidates access.
- PIN quick unlock is intentionally documented as weaker: its encrypted local blob can be attacked offline if an attacker also guesses the six-digit PIN.
- Secrets and note contents are excluded from logs.

## Remaining risks

The renderer timer is not a substitute for OS-level assurance. Clearing application state cannot guarantee secure erasure from WebKit, allocator, swap or crash-report memory. SQLCipher and native file-picker restore are implemented, but the application has not received an independent security audit. PIN unlock remains weaker against offline guessing, and explicit plaintext exports leave the vault's protection boundary. See `docs/security-review.md` for the current detailed review.
