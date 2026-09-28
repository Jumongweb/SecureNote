# Cryptographic design

## Current envelope

The vault file begins with a fixed magic value and version, followed by a serialized envelope. The envelope includes:

- a random 16-byte Argon2id salt;
- explicit Argon2id memory, iterations, and parallelism parameters;
- a random 24-byte XChaCha20-Poly1305 nonce;
- authenticated ciphertext containing the vault payload.

The password is never stored. The derived 32-byte key is used only during the command and is zeroized where the library permits.

## Rationale

Argon2id is memory-hard and slows offline guessing. XChaCha20-Poly1305 is an established AEAD construction with a large nonce space, making securely generated random nonces practical.

The current version derives a wrapping key from the master password and generates a separate random 32-byte vault data key. The data key is wrapped with XChaCha20-Poly1305 and then used for the vault payload and SQLCipher database. Password changes generate a new wrapping salt/key and rewrap the same data key without rekeying the database.

Version 1 envelopes remain readable for migration; they used the password-derived key directly. Any subsequent write upgrades them to version 2.

## Quick unlock

Touch ID stores the data key and password-wrapping key in a macOS Keychain generic-password item protected by `biometryCurrentSet`. The app never receives biometric data. The master password remains the fallback and recovery authority.

PIN unlock stores the same two keys encrypted under an Argon2id-derived PIN key in a local blob. Because a six-digit PIN has low entropy, this path is convenience access rather than an equivalent security boundary to the master password or Touch ID.

## Operational limits

Cryptographic correctness does not make the desktop application audited or immune to compromised dependencies, OS-level malware, memory disclosure, swap files, crash dumps, or user-selected plaintext exports.
