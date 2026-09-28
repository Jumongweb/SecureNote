use argon2::{Argon2, Params};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    ffi::{c_char, CStr, CString},
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use thiserror::Error;
use zeroize::Zeroizing;

mod biometric;
mod database;

const MAGIC: &str = "SNV1";
const ARGON_MEMORY_KIB: u32 = 64 * 1024;
const ARGON_TIME: u32 = 3;
const ARGON_LANES: u32 = 1;

#[derive(Debug, Error)]
enum VaultError {
    #[error("vault does not exist")]
    Missing,
    #[error("vault already exists")]
    Exists,
    #[error("invalid password or corrupted vault")]
    Authentication,
    #[error("vault is locked")]
    Locked,
    #[error("vault storage error")]
    Storage(#[from] std::io::Error),
    #[error("vault serialization error")]
    Serialization(#[from] serde_json::Error),
    #[error("cryptographic operation failed")]
    Crypto,
    #[error("invalid password")]
    Password,
    #[error("requested item was not found")]
    NotFound,
    #[error("encrypted database error")]
    Database,
    #[error("quick unlock is unavailable or invalid")]
    QuickUnlock,
    #[error("Touch ID setup failed: {0}")]
    QuickUnlockDetail(String),
    #[error("too many incorrect PIN attempts; try again in {0} seconds")]
    PinRateLimited(u64),
    #[error("attachments must be 25 MB or smaller")]
    AttachmentTooLarge,
    #[error("on-device text recognition failed: {0}")]
    Ocr(String),
    #[error("secure clipboard operation failed")]
    Clipboard,
}

impl serde::Serialize for VaultError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct NoteVersion {
    pub id: i64,
    pub note_id: String,
    pub title: String,
    pub content: String,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub created_at: String,
    pub saved_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub note_id: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub created_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SavedSearch {
    pub id: String,
    pub name: String,
    pub query: String,
}

#[derive(Default, Serialize, Deserialize)]
struct VaultData {
    notes: Vec<Note>,
}

#[derive(Serialize, Deserialize)]
struct VaultEnvelope {
    magic: String,
    version: u8,
    salt: Vec<u8>,
    memory_kib: u32,
    time_cost: u32,
    lanes: u32,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    #[serde(default)]
    key_nonce: Vec<u8>,
    #[serde(default)]
    wrapped_key: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct BackupPayload {
    vault: VaultEnvelope,
    database: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct BackupContainer {
    magic: String,
    version: u8,
    salt: Vec<u8>,
    memory_kib: u32,
    time_cost: u32,
    lanes: u32,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    #[serde(default)]
    created_at: String,
}

#[derive(Serialize, Deserialize)]
struct RecoveryEnvelope {
    magic: String,
    version: u8,
    salt: Vec<u8>,
    nonce: Vec<u8>,
    wrapped_key: Vec<u8>,
}

#[derive(Serialize)]
struct BackupInfo {
    note_count: usize,
    attachment_count: i64,
    created_at: String,
    valid: bool,
}

#[derive(Serialize)]
struct AttachmentPreview {
    name: String,
    mime: String,
    data_base64: String,
}

#[derive(Serialize)]
struct OcrResult {
    text: String,
    line_count: usize,
}

#[derive(Deserialize)]
struct ReminderRequest {
    id: String,
    due_at: i64,
}

#[cfg(target_os = "macos")]
fn recognize_image_text(data: &[u8]) -> Result<String, VaultError> {
    unsafe extern "C" {
        fn snv_recognize_text(bytes: *const u8, length: usize) -> *mut c_char;
        fn snv_free_string(value: *mut c_char);
    }
    let value = unsafe { snv_recognize_text(data.as_ptr(), data.len()) };
    if value.is_null() {
        return Err(VaultError::Ocr("Apple Vision returned no result".into()));
    }
    let text = unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned();
    unsafe { snv_free_string(value) };
    Ok(text)
}

#[cfg(not(target_os = "macos"))]
fn recognize_image_text(_data: &[u8]) -> Result<String, VaultError> {
    Err(VaultError::Ocr(
        "OCR is currently available on macOS".into(),
    ))
}

#[derive(Serialize)]
struct SecurityDiagnostics {
    database_integrity: bool,
    signed_build: bool,
    recovery_enabled: bool,
    pin_enabled: bool,
    biometric_enabled: bool,
    note_count: usize,
    attachment_count: i64,
}

#[derive(Serialize, Deserialize)]
struct SharedNoteContainer {
    magic: String,
    version: u8,
    salt: Vec<u8>,
    memory_kib: u32,
    time_cost: u32,
    lanes: u32,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct QuickUnlockEnvelope {
    magic: String,
    version: u8,
    salt: Vec<u8>,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

struct UnlockedVault {
    key: Zeroizing<Vec<u8>>,
    password_key: Zeroizing<Vec<u8>>,
    salt: Vec<u8>,
    memory_kib: u32,
    time_cost: u32,
    lanes: u32,
    data: VaultData,
}
pub struct VaultState(pub(crate) Mutex<Option<UnlockedVault>>);

#[derive(Default)]
struct PinThrottle {
    failed_attempts: u8,
    blocked_until: u64,
}
struct PinThrottleState(Mutex<PinThrottle>);

fn vault_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
    let dir = app.path().app_data_dir().map_err(|_| {
        VaultError::Storage(std::io::Error::new(
            std::io::ErrorKind::Other,
            "app data path unavailable",
        ))
    })?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("vault.snv"))
}

fn database_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(vault_path(app)?.with_file_name("vault.db"))
}

fn pin_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(vault_path(app)?.with_file_name("pin-unlock.json"))
}
fn biometric_marker_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(vault_path(app)?.with_file_name("biometric-enabled"))
}

fn recovery_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(vault_path(app)?.with_file_name("recovery-key.json"))
}

fn pin_key(pin: &str, salt: &[u8]) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    derive_key(
        &format!("secure-note-pin:{pin}"),
        salt,
        ARGON_MEMORY_KIB,
        ARGON_TIME,
        ARGON_LANES,
    )
}

fn quick_unlock_blob(
    data_key: &[u8],
    password_key: &[u8],
    pin: &str,
) -> Result<QuickUnlockEnvelope, VaultError> {
    if pin.len() != 6 || !pin.chars().all(|character| character.is_ascii_digit()) {
        return Err(VaultError::Password);
    }
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let key = pin_key(pin, &salt)?;
    let mut plaintext = Vec::with_capacity(data_key.len() + password_key.len());
    plaintext.extend_from_slice(data_key);
    plaintext.extend_from_slice(password_key);
    let (nonce, ciphertext) = encrypt_bytes(&key, &plaintext)?;
    Ok(QuickUnlockEnvelope {
        magic: "SNPIN".into(),
        version: 1,
        salt: salt.to_vec(),
        nonce,
        ciphertext,
    })
}

fn read_quick_unlock(
    path: &Path,
    pin: &str,
) -> Result<(Zeroizing<Vec<u8>>, Zeroizing<Vec<u8>>), VaultError> {
    let raw = fs::read(path).map_err(|_| VaultError::QuickUnlock)?;
    let envelope: QuickUnlockEnvelope =
        serde_json::from_slice(&raw).map_err(|_| VaultError::QuickUnlock)?;
    if envelope.magic != "SNPIN" || envelope.version != 1 || envelope.salt.len() != 16 {
        return Err(VaultError::QuickUnlock);
    }
    let key = pin_key(pin, &envelope.salt)?;
    let plaintext = decrypt_bytes(&key, &envelope.nonce, &envelope.ciphertext)
        .map_err(|_| VaultError::QuickUnlock)?;
    if plaintext.len() != 64 {
        return Err(VaultError::QuickUnlock);
    }
    Ok((
        Zeroizing::new(plaintext[..32].to_vec()),
        Zeroizing::new(plaintext[32..].to_vec()),
    ))
}

fn decrypt_data_with_key(
    envelope: &VaultEnvelope,
    data_key: &[u8],
) -> Result<VaultData, VaultError> {
    if envelope.magic != MAGIC || envelope.version < 1 || envelope.nonce.len() != 24 {
        return Err(VaultError::Authentication);
    }
    let plaintext = decrypt_bytes(data_key, &envelope.nonce, &envelope.ciphertext)?;
    serde_json::from_slice(&plaintext).map_err(VaultError::from)
}

fn derive_key(
    password: &str,
    salt: &[u8],
    memory: u32,
    time: u32,
    lanes: u32,
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    if password.len() < 8 {
        return Err(VaultError::Password);
    }
    let params = Params::new(memory, time, lanes, Some(32)).map_err(|_| VaultError::Crypto)?;
    let argon = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut output = Zeroizing::new(vec![0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, &mut output)
        .map_err(|_| VaultError::Authentication)?;
    Ok(output)
}

fn encrypt(
    data: &VaultData,
    password: &str,
) -> Result<(VaultEnvelope, Zeroizing<Vec<u8>>, Zeroizing<Vec<u8>>), VaultError> {
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let password_key = derive_key(password, &salt, ARGON_MEMORY_KIB, ARGON_TIME, ARGON_LANES)?;
    let mut data_key = Zeroizing::new(vec![0u8; 32]);
    rand::rng().fill_bytes(&mut data_key);
    let (key_nonce, wrapped_key) = encrypt_bytes(&password_key, &data_key)?;
    let (nonce, ciphertext) = encrypt_bytes(&data_key, &serde_json::to_vec(data)?)?;
    Ok((
        VaultEnvelope {
            magic: MAGIC.into(),
            version: 2,
            salt: salt.to_vec(),
            memory_kib: ARGON_MEMORY_KIB,
            time_cost: ARGON_TIME,
            lanes: ARGON_LANES,
            nonce,
            ciphertext,
            key_nonce,
            wrapped_key,
        },
        data_key,
        password_key,
    ))
}

fn encrypt_with_key(
    data: &VaultData,
    data_key: &[u8],
    password_key: &[u8],
    salt: &[u8],
    memory_kib: u32,
    time_cost: u32,
    lanes: u32,
) -> Result<VaultEnvelope, VaultError> {
    let (key_nonce, wrapped_key) = encrypt_bytes(password_key, data_key)?;
    let (nonce, ciphertext) = encrypt_bytes(data_key, &serde_json::to_vec(data)?)?;
    Ok(VaultEnvelope {
        magic: MAGIC.into(),
        version: 2,
        salt: salt.to_vec(),
        memory_kib,
        time_cost,
        lanes,
        nonce,
        ciphertext,
        key_nonce,
        wrapped_key,
    })
}

fn decrypt(
    envelope: &VaultEnvelope,
    password: &str,
) -> Result<(VaultData, Zeroizing<Vec<u8>>, Zeroizing<Vec<u8>>), VaultError> {
    if envelope.magic != MAGIC
        || (envelope.version != 1 && envelope.version != 2)
        || envelope.salt.len() != 16
        || envelope.nonce.len() != 24
    {
        return Err(VaultError::Authentication);
    }
    let password_key = derive_key(
        password,
        &envelope.salt,
        envelope.memory_kib,
        envelope.time_cost,
        envelope.lanes,
    )?;
    let data_key = if envelope.version == 1 {
        password_key.clone()
    } else {
        Zeroizing::new(decrypt_bytes(
            &password_key,
            &envelope.key_nonce,
            &envelope.wrapped_key,
        )?)
    };
    let plaintext = if envelope.version == 1 {
        decrypt_bytes(&data_key, &envelope.nonce, &envelope.ciphertext)?
    } else {
        decrypt_bytes(&data_key, &envelope.nonce, &envelope.ciphertext)?
    };
    Ok((serde_json::from_slice(&plaintext)?, data_key, password_key))
}

fn write_envelope(app: &AppHandle, envelope: &VaultEnvelope) -> Result<(), VaultError> {
    write_atomic(&vault_path(app)?, &serde_json::to_vec(envelope)?)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), VaultError> {
    let temp = path.with_extension("tmp");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(temp, path)?;
    Ok(())
}

fn encrypt_bytes(key: &[u8], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), VaultError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| VaultError::Crypto)?;
    let mut nonce = [0u8; 24];
    rand::rng().fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| VaultError::Crypto)?;
    Ok((nonce.to_vec(), ciphertext))
}

fn decrypt_bytes(key: &[u8], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, VaultError> {
    if nonce.len() != 24 {
        return Err(VaultError::Authentication);
    }
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| VaultError::Crypto)?;
    cipher
        .decrypt(XNonce::from_slice(nonce), ciphertext)
        .map_err(|_| VaultError::Authentication)
}

fn read_envelope(path: &Path) -> Result<VaultEnvelope, VaultError> {
    let raw = fs::read(path).map_err(|_| VaultError::Missing)?;
    serde_json::from_slice(&raw).map_err(|_| VaultError::Authentication)
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn timestamp_millis() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn persist_unlocked(app: &AppHandle, vault: &UnlockedVault) -> Result<(), VaultError> {
    let connection = database::open(&database_path(app)?, &vault.key)?;
    database::remove_notes_except(&connection, &vault.data.notes)?;
    for note in &vault.data.notes {
        database::save_note(&connection, note)?;
    }
    let envelope = encrypt_with_key(
        &vault.data,
        &vault.key,
        &vault.password_key,
        &vault.salt,
        vault.memory_kib,
        vault.time_cost,
        vault.lanes,
    )?;
    write_envelope(app, &envelope)?;
    Ok(())
}

#[tauri::command]
fn vault_status(app: AppHandle, state: State<'_, VaultState>) -> Result<String, VaultError> {
    if state.0.lock().map_err(|_| VaultError::Locked)?.is_some() {
        return Ok("unlocked".into());
    }
    Ok(if vault_path(&app)?.exists() {
        "locked"
    } else {
        "not-created"
    }
    .into())
}

#[tauri::command]
fn create_vault(
    app: AppHandle,
    password: String,
    state: State<'_, VaultState>,
) -> Result<(), VaultError> {
    if password.len() < 8 {
        return Err(VaultError::Password);
    }
    let path = vault_path(&app)?;
    if path.exists() {
        return Err(VaultError::Exists);
    }
    let _ = fs::remove_file(recovery_path(&app)?);
    let data = VaultData::default();
    let (envelope, key, password_key) = encrypt(&data, &password)?;
    write_envelope(&app, &envelope)?;
    let connection = database::open(&database_path(&app)?, &key)?;
    for note in &data.notes {
        database::save_note(&connection, note)?;
    }
    *state.0.lock().map_err(|_| VaultError::Locked)? = Some(UnlockedVault {
        key,
        password_key,
        salt: envelope.salt,
        memory_kib: envelope.memory_kib,
        time_cost: envelope.time_cost,
        lanes: envelope.lanes,
        data,
    });
    Ok(())
}

#[tauri::command]
fn unlock_vault(
    app: AppHandle,
    password: String,
    state: State<'_, VaultState>,
) -> Result<Vec<Note>, VaultError> {
    let envelope = read_envelope(&vault_path(&app)?)?;
    let (data, key, password_key) = decrypt(&envelope, &password)?;
    let mut data = data;
    let connection = database::open(&database_path(&app)?, &key)?;
    let stored_notes = database::load_notes(&connection)?;
    if stored_notes.is_empty() && !data.notes.is_empty() {
        for note in &data.notes {
            database::save_note(&connection, note)?;
        }
    } else {
        data.notes = stored_notes;
    }
    let notes = data.notes.clone();
    *state.0.lock().map_err(|_| VaultError::Locked)? = Some(UnlockedVault {
        key,
        password_key,
        salt: envelope.salt,
        memory_kib: envelope.memory_kib,
        time_cost: envelope.time_cost,
        lanes: envelope.lanes,
        data,
    });
    Ok(notes)
}

#[tauri::command]
fn enable_pin_unlock(
    app: AppHandle,
    master_password: String,
    pin: String,
) -> Result<(), VaultError> {
    let envelope = read_envelope(&vault_path(&app)?)?;
    let (_, data_key, password_key) = decrypt(&envelope, &master_password)?;
    let quick = quick_unlock_blob(&data_key, &password_key, &pin)?;
    write_atomic(&pin_path(&app)?, &serde_json::to_vec(&quick)?)
}

#[tauri::command]
fn enable_biometric_unlock(app: AppHandle, master_password: String) -> Result<(), VaultError> {
    let envelope = read_envelope(&vault_path(&app)?)?;
    let (_, data_key, password_key) = decrypt(&envelope, &master_password)?;
    let mut material = Vec::with_capacity(64);
    material.extend_from_slice(&data_key);
    material.extend_from_slice(&password_key);
    biometric::store(&material).map_err(VaultError::QuickUnlockDetail)?;
    write_atomic(&biometric_marker_path(&app)?, b"enabled")
}

#[tauri::command]
fn unlock_pin(
    app: AppHandle,
    pin: String,
    state: State<'_, VaultState>,
    throttle_state: State<'_, PinThrottleState>,
) -> Result<Vec<Note>, VaultError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    {
        let throttle = throttle_state
            .0
            .lock()
            .map_err(|_| VaultError::QuickUnlock)?;
        if throttle.blocked_until > now {
            return Err(VaultError::PinRateLimited(throttle.blocked_until - now));
        }
    }
    let (data_key, password_key) = match read_quick_unlock(&pin_path(&app)?, &pin) {
        Ok(material) => material,
        Err(error) => {
            let mut throttle = throttle_state
                .0
                .lock()
                .map_err(|_| VaultError::QuickUnlock)?;
            throttle.failed_attempts = throttle.failed_attempts.saturating_add(1);
            if throttle.failed_attempts >= 5 {
                throttle.blocked_until = now + 30;
                throttle.failed_attempts = 0;
                return Err(VaultError::PinRateLimited(30));
            }
            return Err(error);
        }
    };
    let envelope = read_envelope(&vault_path(&app)?)?;
    let mut data = decrypt_data_with_key(&envelope, &data_key)?;
    let connection = database::open(&database_path(&app)?, &data_key)?;
    let stored_notes = database::load_notes(&connection)?;
    if !stored_notes.is_empty() {
        data.notes = stored_notes;
    }
    let notes = data.notes.clone();
    *state.0.lock().map_err(|_| VaultError::Locked)? = Some(UnlockedVault {
        key: data_key,
        password_key,
        salt: envelope.salt,
        memory_kib: envelope.memory_kib,
        time_cost: envelope.time_cost,
        lanes: envelope.lanes,
        data,
    });
    *throttle_state
        .0
        .lock()
        .map_err(|_| VaultError::QuickUnlock)? = PinThrottle::default();
    Ok(notes)
}

#[tauri::command]
fn unlock_biometric(app: AppHandle, state: State<'_, VaultState>) -> Result<Vec<Note>, VaultError> {
    let material = biometric::load().map_err(VaultError::QuickUnlockDetail)?;
    if material.len() != 64 {
        return Err(VaultError::QuickUnlock);
    }
    let data_key = Zeroizing::new(material[..32].to_vec());
    let password_key = Zeroizing::new(material[32..].to_vec());
    let envelope = read_envelope(&vault_path(&app)?)?;
    let mut data = decrypt_data_with_key(&envelope, &data_key)?;
    let connection = database::open(&database_path(&app)?, &data_key)?;
    let stored_notes = database::load_notes(&connection)?;
    if !stored_notes.is_empty() {
        data.notes = stored_notes;
    }
    let notes = data.notes.clone();
    *state.0.lock().map_err(|_| VaultError::Locked)? = Some(UnlockedVault {
        key: data_key,
        password_key,
        salt: envelope.salt,
        memory_kib: envelope.memory_kib,
        time_cost: envelope.time_cost,
        lanes: envelope.lanes,
        data,
    });
    Ok(notes)
}

#[tauri::command]
fn quick_unlock_status(app: AppHandle) -> Result<(bool, bool), VaultError> {
    Ok((
        pin_path(&app)?.exists(),
        biometric_marker_path(&app)?.exists(),
    ))
}

#[tauri::command]
fn disable_quick_unlock(app: AppHandle, master_password: String) -> Result<(), VaultError> {
    let envelope = read_envelope(&vault_path(&app)?)?;
    let _ = decrypt(&envelope, &master_password)?;
    let _ = fs::remove_file(pin_path(&app)?);
    let _ = biometric::delete();
    let _ = fs::remove_file(biometric_marker_path(&app)?);
    Ok(())
}

#[tauri::command]
fn lock_vault(state: State<'_, VaultState>) -> Result<(), VaultError> {
    *state.0.lock().map_err(|_| VaultError::Locked)? = None;
    Ok(())
}

#[cfg(target_os = "macos")]
fn write_macos_clipboard(value: &[u8]) -> Result<(), VaultError> {
    let mut child = Command::new("/usr/bin/pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|_| VaultError::Clipboard)?;
    child
        .stdin
        .as_mut()
        .ok_or(VaultError::Clipboard)?
        .write_all(value)
        .map_err(|_| VaultError::Clipboard)?;
    if child.wait().map_err(|_| VaultError::Clipboard)?.success() {
        Ok(())
    } else {
        Err(VaultError::Clipboard)
    }
}

#[tauri::command]
fn copy_secret(value: String, state: State<'_, VaultState>) -> Result<(), VaultError> {
    if state.0.lock().map_err(|_| VaultError::Locked)?.is_none() {
        return Err(VaultError::Locked);
    }
    if value.is_empty() || value.len() > 16 * 1024 {
        return Err(VaultError::Clipboard);
    }
    #[cfg(target_os = "macos")]
    {
        write_macos_clipboard(value.as_bytes())?;
        let expected = Zeroizing::new(value);
        thread::spawn(move || {
            thread::sleep(std::time::Duration::from_secs(30));
            let current = Command::new("/usr/bin/pbpaste").output();
            if current
                .as_ref()
                .map(|output| output.stdout.as_slice() == expected.as_bytes())
                .unwrap_or(false)
            {
                let _ = write_macos_clipboard(b"");
            }
        });
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    Err(VaultError::Clipboard)
}

#[tauri::command]
fn activity_timestamps(
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<Vec<String>, VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    database::activity_timestamps(&connection)
}

#[cfg(target_os = "macos")]
fn replace_native_reminders(reminders: &[ReminderRequest]) {
    unsafe extern "C" {
        fn snv_clear_reminders();
        fn snv_schedule_reminder(identifier: *const c_char, epoch_seconds: f64);
    }
    unsafe { snv_clear_reminders() };
    for reminder in reminders {
        if let Ok(identifier) = CString::new(reminder.id.as_str()) {
            unsafe { snv_schedule_reminder(identifier.as_ptr(), reminder.due_at as f64) };
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn replace_native_reminders(_reminders: &[ReminderRequest]) {}

#[tauri::command]
fn sync_reminders(
    reminders: Vec<ReminderRequest>,
    state: State<'_, VaultState>,
) -> Result<(), VaultError> {
    if state.0.lock().map_err(|_| VaultError::Locked)?.is_none() {
        return Err(VaultError::Locked);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let safe: Vec<_> = reminders
        .into_iter()
        .filter(|item| item.due_at > now && item.id.len() <= 180 && item.id.is_ascii())
        .take(256)
        .collect();
    replace_native_reminders(&safe);
    Ok(())
}

#[tauri::command]
fn save_note(app: AppHandle, note: Note, state: State<'_, VaultState>) -> Result<Note, VaultError> {
    let mut guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_mut().ok_or(VaultError::Locked)?;
    if let Some(existing) = vault.data.notes.iter_mut().find(|item| item.id == note.id) {
        if existing.title != note.title
            || existing.content != note.content
            || existing.folder != note.folder
            || existing.tags != note.tags
        {
            let connection = database::open(&database_path(&app)?, &vault.key)?;
            if database::note_exists(&connection, &existing.id) {
                database::save_version(&connection, existing, &timestamp_millis())?;
            }
        }
        *existing = note.clone();
    } else {
        vault.data.notes.insert(0, note.clone());
    }
    persist_unlocked(&app, vault)?;
    let _ = app.emit("note-saved", note.clone());
    Ok(note)
}

#[tauri::command]
fn note_versions(
    app: AppHandle,
    note_id: String,
    state: State<'_, VaultState>,
) -> Result<Vec<NoteVersion>, VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    database::load_versions(&connection, &note_id)
}

#[tauri::command]
fn restore_note_version(
    app: AppHandle,
    version_id: i64,
    updated_at: String,
    state: State<'_, VaultState>,
) -> Result<Note, VaultError> {
    let mut guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_mut().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    let version = database::load_version(&connection, version_id)?;
    let note = vault
        .data
        .notes
        .iter_mut()
        .find(|note| note.id == version.note_id)
        .ok_or(VaultError::NotFound)?;
    database::save_version(&connection, note, &timestamp_millis())?;
    note.title = version.title;
    note.content = version.content;
    note.folder = version.folder;
    note.tags = version.tags;
    note.updated_at = updated_at;
    let restored = note.clone();
    drop(connection);
    persist_unlocked(&app, vault)?;
    Ok(restored)
}

fn mime_for_path(path: &Path) -> String {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .into()
}

#[tauri::command]
fn add_attachment(
    app: AppHandle,
    note_id: String,
    path: String,
    created_at: String,
    state: State<'_, VaultState>,
) -> Result<Attachment, VaultError> {
    let source = PathBuf::from(path);
    let metadata = fs::metadata(&source)?;
    if metadata.len() > 25 * 1024 * 1024 {
        return Err(VaultError::AttachmentTooLarge);
    }
    let data = fs::read(&source)?;
    let mut random_id = [0u8; 16];
    rand::rng().fill_bytes(&mut random_id);
    let attachment = Attachment {
        id: random_id.iter().map(|byte| format!("{byte:02x}")).collect(),
        note_id,
        name: source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("attachment")
            .to_string(),
        mime: mime_for_path(&source),
        size: metadata.len() as i64,
        created_at,
    };
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    database::save_attachment(&connection, &attachment, &data)?;
    Ok(attachment)
}

#[tauri::command]
fn list_attachments(
    app: AppHandle,
    note_id: String,
    state: State<'_, VaultState>,
) -> Result<Vec<Attachment>, VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    database::load_attachments(&connection, &note_id)
}

#[tauri::command]
fn export_attachment(
    app: AppHandle,
    id: String,
    destination: String,
    state: State<'_, VaultState>,
) -> Result<(), VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    let (_, data) = database::attachment_data(&connection, &id)?;
    write_atomic(Path::new(&destination), &data)
}

#[tauri::command]
fn remove_attachment(
    app: AppHandle,
    id: String,
    state: State<'_, VaultState>,
) -> Result<(), VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    database::delete_attachment(&connection, &id)
}

#[tauri::command]
fn preview_attachment(
    app: AppHandle,
    id: String,
    state: State<'_, VaultState>,
) -> Result<AttachmentPreview, VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    let (name, data) = database::attachment_data(&connection, &id)?;
    Ok(AttachmentPreview {
        mime: mime_for_path(Path::new(&name)),
        name,
        data_base64: BASE64.encode(data),
    })
}

#[tauri::command]
fn recognize_attachment_text(
    app: AppHandle,
    id: String,
    state: State<'_, VaultState>,
) -> Result<OcrResult, VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    let (name, data) = database::attachment_data(&connection, &id)?;
    if !mime_for_path(Path::new(&name)).starts_with("image/") {
        return Err(VaultError::Ocr(
            "only image attachments can be scanned".into(),
        ));
    }
    let text = recognize_image_text(&data)?;
    if text.trim().is_empty() {
        return Err(VaultError::Ocr(
            "no readable text was found in this image".into(),
        ));
    }
    Ok(OcrResult {
        line_count: text.lines().filter(|line| !line.trim().is_empty()).count(),
        text,
    })
}

#[tauri::command]
fn import_note_files(
    app: AppHandle,
    paths: Vec<String>,
    created_at: String,
    state: State<'_, VaultState>,
) -> Result<Vec<Note>, VaultError> {
    let mut imported = Vec::new();
    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        if fs::metadata(&path)?.len() > 5 * 1024 * 1024 {
            return Err(VaultError::AttachmentTooLarge);
        }
        let content = fs::read_to_string(&path)?;
        let title = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Imported note")
            .to_string();
        let folder = path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|value| value.to_str())
            .map(String::from);
        imported.push(Note {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            content,
            created_at: created_at.clone(),
            updated_at: created_at.clone(),
            folder,
            tags: vec!["imported".into()],
            pinned: false,
            archived: false,
            deleted_at: None,
        });
    }
    let mut guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_mut().ok_or(VaultError::Locked)?;
    for note in imported.iter().rev() {
        vault.data.notes.insert(0, note.clone());
    }
    persist_unlocked(&app, vault)?;
    Ok(imported)
}

#[tauri::command]
fn export_note_markdown(
    _app: AppHandle,
    id: String,
    destination: String,
    state: State<'_, VaultState>,
) -> Result<(), VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let note = vault
        .data
        .notes
        .iter()
        .find(|note| note.id == id)
        .ok_or(VaultError::NotFound)?;
    let body = format!("# {}\n\n{}", note.title, note.content);
    let destination = PathBuf::from(destination);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    write_atomic(&destination, body.as_bytes())
}

#[tauri::command]
fn export_shared_note(
    _app: AppHandle,
    id: String,
    destination: String,
    password: String,
    state: State<'_, VaultState>,
) -> Result<(), VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let note = vault
        .data
        .notes
        .iter()
        .find(|note| note.id == id)
        .ok_or(VaultError::NotFound)?;
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let key = derive_key(&password, &salt, ARGON_MEMORY_KIB, ARGON_TIME, ARGON_LANES)?;
    let (nonce, ciphertext) = encrypt_bytes(&key, &serde_json::to_vec(note)?)?;
    let container = SharedNoteContainer {
        magic: "SNSH".into(),
        version: 1,
        salt: salt.to_vec(),
        memory_kib: ARGON_MEMORY_KIB,
        time_cost: ARGON_TIME,
        lanes: ARGON_LANES,
        nonce,
        ciphertext,
    };
    let destination = PathBuf::from(destination);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    write_atomic(&destination, &serde_json::to_vec(&container)?)
}

#[tauri::command]
fn import_shared_note(
    app: AppHandle,
    path: String,
    password: String,
    imported_at: String,
    state: State<'_, VaultState>,
) -> Result<Note, VaultError> {
    let raw = fs::read(path)?;
    let container: SharedNoteContainer =
        serde_json::from_slice(&raw).map_err(|_| VaultError::Authentication)?;
    if container.magic != "SNSH" || container.version != 1 || container.salt.len() != 16 {
        return Err(VaultError::Authentication);
    }
    let key = derive_key(
        &password,
        &container.salt,
        container.memory_kib,
        container.time_cost,
        container.lanes,
    )?;
    let plaintext = decrypt_bytes(&key, &container.nonce, &container.ciphertext)?;
    let mut note: Note =
        serde_json::from_slice(&plaintext).map_err(|_| VaultError::Authentication)?;
    note.id = uuid::Uuid::new_v4().to_string();
    note.created_at = imported_at.clone();
    note.updated_at = imported_at;
    note.deleted_at = None;
    let mut guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_mut().ok_or(VaultError::Locked)?;
    vault.data.notes.insert(0, note.clone());
    persist_unlocked(&app, vault)?;
    Ok(note)
}

#[tauri::command]
fn list_saved_searches(
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<Vec<SavedSearch>, VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    database::load_saved_searches(&connection)
}

#[tauri::command]
fn save_search(
    app: AppHandle,
    name: String,
    query: String,
    state: State<'_, VaultState>,
) -> Result<SavedSearch, VaultError> {
    if name.trim().is_empty() || query.trim().is_empty() {
        return Err(VaultError::NotFound);
    }
    let search = SavedSearch {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        query,
    };
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    database::save_search(&connection, &search)?;
    Ok(search)
}

#[tauri::command]
fn delete_saved_search(
    app: AppHandle,
    id: String,
    state: State<'_, VaultState>,
) -> Result<(), VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    database::delete_search(&connection, &id)
}

#[tauri::command]
fn security_diagnostics(
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<SecurityDiagnostics, VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    let connection = database::open(&database_path(&app)?, &vault.key)?;
    let database_integrity = database::integrity_check(&connection).is_ok();
    let attachment_count = database::attachment_count(&connection)?;
    #[cfg(target_os = "macos")]
    let signed_build = std::env::current_exe()
        .ok()
        .and_then(|path| {
            std::process::Command::new("/usr/bin/codesign")
                .arg("--verify")
                .arg(path)
                .status()
                .ok()
        })
        .is_some_and(|status| status.success());
    #[cfg(not(target_os = "macos"))]
    let signed_build = false;
    Ok(SecurityDiagnostics {
        database_integrity,
        signed_build,
        recovery_enabled: recovery_path(&app)?.exists(),
        pin_enabled: pin_path(&app)?.exists(),
        biometric_enabled: biometric_marker_path(&app)?.exists(),
        note_count: vault.data.notes.len(),
        attachment_count,
    })
}

#[tauri::command]
fn delete_note(app: AppHandle, id: String, state: State<'_, VaultState>) -> Result<(), VaultError> {
    let mut guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_mut().ok_or(VaultError::Locked)?;
    let note = vault
        .data
        .notes
        .iter_mut()
        .find(|note| note.id == id)
        .ok_or(VaultError::NotFound)?;
    note.deleted_at = Some(timestamp());
    persist_unlocked(&app, vault)?;
    Ok(())
}

#[tauri::command]
fn restore_note(
    app: AppHandle,
    id: String,
    state: State<'_, VaultState>,
) -> Result<(), VaultError> {
    let mut guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_mut().ok_or(VaultError::Locked)?;
    let note = vault
        .data
        .notes
        .iter_mut()
        .find(|note| note.id == id)
        .ok_or(VaultError::NotFound)?;
    note.deleted_at = None;
    persist_unlocked(&app, vault)
}

#[tauri::command]
fn permanent_delete_note(
    app: AppHandle,
    id: String,
    state: State<'_, VaultState>,
) -> Result<(), VaultError> {
    let mut guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_mut().ok_or(VaultError::Locked)?;
    let before = vault.data.notes.len();
    vault.data.notes.retain(|note| note.id != id);
    if before == vault.data.notes.len() {
        return Err(VaultError::NotFound);
    }
    persist_unlocked(&app, vault)
}

#[tauri::command]
fn change_password(
    app: AppHandle,
    current_password: String,
    new_password: String,
    state: State<'_, VaultState>,
) -> Result<(), VaultError> {
    if new_password.len() < 8 {
        return Err(VaultError::Password);
    }
    let path = vault_path(&app)?;
    let envelope = read_envelope(&path)?;
    let (data, data_key, _) = decrypt(&envelope, &current_password)?;
    let mut new_salt = [0u8; 16];
    rand::rng().fill_bytes(&mut new_salt);
    let new_password_key = derive_key(
        &new_password,
        &new_salt,
        ARGON_MEMORY_KIB,
        ARGON_TIME,
        ARGON_LANES,
    )?;
    let new_envelope = encrypt_with_key(
        &data,
        &data_key,
        &new_password_key,
        &new_salt,
        ARGON_MEMORY_KIB,
        ARGON_TIME,
        ARGON_LANES,
    )?;
    let _ = fs::remove_file(pin_path(&app)?);
    let _ = biometric::delete();
    let _ = fs::remove_file(biometric_marker_path(&app)?);
    write_envelope(&app, &new_envelope)?;
    *state.0.lock().map_err(|_| VaultError::Locked)? = Some(UnlockedVault {
        key: data_key,
        password_key: new_password_key,
        salt: new_envelope.salt,
        memory_kib: new_envelope.memory_kib,
        time_cost: new_envelope.time_cost,
        lanes: new_envelope.lanes,
        data,
    });
    Ok(())
}

fn normalized_recovery_code(code: &str) -> String {
    code.chars()
        .filter(|character| character.is_ascii_hexdigit())
        .collect::<String>()
        .to_ascii_lowercase()
}

#[tauri::command]
fn generate_recovery_key(app: AppHandle, master_password: String) -> Result<String, VaultError> {
    let envelope = read_envelope(&vault_path(&app)?)?;
    let (_, data_key, _) = decrypt(&envelope, &master_password)?;
    let mut secret = [0u8; 32];
    rand::rng().fill_bytes(&mut secret);
    let raw_code = secret
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    let display_code = raw_code
        .as_bytes()
        .chunks(4)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join("-");
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let recovery_key = derive_key(
        &raw_code.to_ascii_lowercase(),
        &salt,
        ARGON_MEMORY_KIB,
        ARGON_TIME,
        ARGON_LANES,
    )?;
    let (nonce, wrapped_key) = encrypt_bytes(&recovery_key, &data_key)?;
    let recovery = RecoveryEnvelope {
        magic: "SNREC".into(),
        version: 1,
        salt: salt.to_vec(),
        nonce,
        wrapped_key,
    };
    write_atomic(&recovery_path(&app)?, &serde_json::to_vec(&recovery)?)?;
    Ok(display_code)
}

#[tauri::command]
fn recovery_key_status(app: AppHandle) -> Result<bool, VaultError> {
    Ok(recovery_path(&app)?.exists())
}

#[tauri::command]
fn recover_vault(
    app: AppHandle,
    recovery_code: String,
    new_password: String,
    state: State<'_, VaultState>,
) -> Result<Vec<Note>, VaultError> {
    if new_password.len() < 8 {
        return Err(VaultError::Password);
    }
    let raw = fs::read(recovery_path(&app)?).map_err(|_| VaultError::Missing)?;
    let recovery: RecoveryEnvelope =
        serde_json::from_slice(&raw).map_err(|_| VaultError::Authentication)?;
    if recovery.magic != "SNREC" || recovery.version != 1 || recovery.salt.len() != 16 {
        return Err(VaultError::Authentication);
    }
    let code = normalized_recovery_code(&recovery_code);
    if code.len() != 64 {
        return Err(VaultError::Authentication);
    }
    let recovery_key = derive_key(
        &code,
        &recovery.salt,
        ARGON_MEMORY_KIB,
        ARGON_TIME,
        ARGON_LANES,
    )?;
    let data_key = Zeroizing::new(decrypt_bytes(
        &recovery_key,
        &recovery.nonce,
        &recovery.wrapped_key,
    )?);
    if data_key.len() != 32 {
        return Err(VaultError::Authentication);
    }
    let old_envelope = read_envelope(&vault_path(&app)?)?;
    let mut data = decrypt_data_with_key(&old_envelope, &data_key)?;
    let connection = database::open(&database_path(&app)?, &data_key)?;
    let notes = database::load_notes(&connection)?;
    if !notes.is_empty() {
        data.notes = notes;
    }
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let password_key = derive_key(
        &new_password,
        &salt,
        ARGON_MEMORY_KIB,
        ARGON_TIME,
        ARGON_LANES,
    )?;
    let new_envelope = encrypt_with_key(
        &data,
        &data_key,
        &password_key,
        &salt,
        ARGON_MEMORY_KIB,
        ARGON_TIME,
        ARGON_LANES,
    )?;
    write_envelope(&app, &new_envelope)?;
    let _ = fs::remove_file(pin_path(&app)?);
    let _ = biometric::delete();
    let _ = fs::remove_file(biometric_marker_path(&app)?);
    let result = data.notes.clone();
    *state.0.lock().map_err(|_| VaultError::Locked)? = Some(UnlockedVault {
        key: data_key,
        password_key,
        salt: new_envelope.salt,
        memory_kib: new_envelope.memory_kib,
        time_cost: new_envelope.time_cost,
        lanes: new_envelope.lanes,
        data,
    });
    Ok(result)
}

#[tauri::command]
fn create_backup(
    app: AppHandle,
    destination: String,
    state: State<'_, VaultState>,
) -> Result<String, VaultError> {
    let guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    let vault = guard.as_ref().ok_or(VaultError::Locked)?;
    persist_unlocked(&app, vault)?;
    let database = fs::read(database_path(&app)?)?;
    let vault_envelope = encrypt_with_key(
        &vault.data,
        &vault.key,
        &vault.password_key,
        &vault.salt,
        vault.memory_kib,
        vault.time_cost,
        vault.lanes,
    )?;
    let payload = serde_json::to_vec(&BackupPayload {
        vault: vault_envelope,
        database,
    })?;
    let (nonce, ciphertext) = encrypt_bytes(&vault.password_key, &payload)?;
    let container = BackupContainer {
        magic: "SNVB".into(),
        version: 1,
        salt: vault.salt.clone(),
        memory_kib: vault.memory_kib,
        time_cost: vault.time_cost,
        lanes: vault.lanes,
        nonce,
        ciphertext,
        created_at: timestamp_millis(),
    };
    let destination = PathBuf::from(destination);
    if destination == vault_path(&app)? {
        return Err(VaultError::Storage(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "backup destination cannot be the active vault",
        )));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    write_atomic(&destination, &serde_json::to_vec(&container)?)?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn validate_backup(
    app: AppHandle,
    backup_path: String,
    password: String,
) -> Result<BackupInfo, VaultError> {
    let raw = fs::read(Path::new(&backup_path)).map_err(|_| VaultError::Missing)?;
    let container: BackupContainer =
        serde_json::from_slice(&raw).map_err(|_| VaultError::Authentication)?;
    if container.magic != "SNVB" || container.version != 1 || container.salt.len() != 16 {
        return Err(VaultError::Authentication);
    }
    let password_key = derive_key(
        &password,
        &container.salt,
        container.memory_kib,
        container.time_cost,
        container.lanes,
    )?;
    let plaintext = decrypt_bytes(&password_key, &container.nonce, &container.ciphertext)?;
    let payload: BackupPayload =
        serde_json::from_slice(&plaintext).map_err(|_| VaultError::Authentication)?;
    let (_, data_key, _) = decrypt(&payload.vault, &password)?;
    let validation_path = database_path(&app)?.with_file_name("backup-validation.db");
    write_atomic(&validation_path, &payload.database)?;
    let result = (|| {
        let connection = database::open(&validation_path, &data_key)?;
        database::integrity_check(&connection)?;
        let notes = database::load_notes(&connection)?;
        let attachments = database::attachment_count(&connection)?;
        Ok(BackupInfo {
            note_count: notes.len(),
            attachment_count: attachments,
            created_at: container.created_at,
            valid: true,
        })
    })();
    let _ = fs::remove_file(validation_path);
    result
}

#[tauri::command]
fn restore_backup(
    app: AppHandle,
    backup_path: String,
    password: String,
    state: State<'_, VaultState>,
) -> Result<Vec<Note>, VaultError> {
    let raw = fs::read(Path::new(&backup_path)).map_err(|_| VaultError::Missing)?;
    let container: BackupContainer =
        serde_json::from_slice(&raw).map_err(|_| VaultError::Authentication)?;
    if container.magic != "SNVB" || container.version != 1 || container.salt.len() != 16 {
        return Err(VaultError::Authentication);
    }
    let password_key = derive_key(
        &password,
        &container.salt,
        container.memory_kib,
        container.time_cost,
        container.lanes,
    )?;
    let plaintext = decrypt_bytes(&password_key, &container.nonce, &container.ciphertext)?;
    let payload: BackupPayload =
        serde_json::from_slice(&plaintext).map_err(|_| VaultError::Authentication)?;
    let (data, data_key, embedded_password_key) = decrypt(&payload.vault, &password)?;
    if embedded_password_key.as_slice() != password_key.as_slice() {
        return Err(VaultError::Authentication);
    }
    let destination = vault_path(&app)?;
    let db_destination = database_path(&app)?;
    let db_temp = db_destination.with_extension("restore.tmp");
    write_atomic(&db_temp, &payload.database)?;
    let connection = database::open(&db_temp, &data_key)?;
    let database_notes = database::load_notes(&connection)?;
    drop(connection);
    if serde_json::to_vec(&data)?
        != serde_json::to_vec(&VaultData {
            notes: database_notes.clone(),
        })?
    {
        return Err(VaultError::Authentication);
    }
    write_atomic(&destination, &serde_json::to_vec(&payload.vault)?)?;
    fs::rename(db_temp, db_destination)?;
    let _ = fs::remove_file(pin_path(&app)?);
    let _ = biometric::delete();
    let _ = fs::remove_file(biometric_marker_path(&app)?);
    let _ = fs::remove_file(recovery_path(&app)?);
    let mut guard = state.0.lock().map_err(|_| VaultError::Locked)?;
    *guard = Some(UnlockedVault {
        key: data_key,
        password_key,
        salt: payload.vault.salt,
        memory_kib: payload.vault.memory_kib,
        time_cost: payload.vault.time_cost,
        lanes: payload.vault.lanes,
        data: VaultData {
            notes: database_notes.clone(),
        },
    });
    Ok(database_notes)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(VaultState(Mutex::new(None)))
        .manage(PinThrottleState(Mutex::new(PinThrottle::default())))
        .setup(|app| {
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };
                let capture_shortcut =
                    Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyN);
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if shortcut != &capture_shortcut
                                || event.state() != ShortcutState::Pressed
                            {
                                return;
                            }
                            let unlocked = app
                                .try_state::<VaultState>()
                                .and_then(|state| state.0.lock().ok().map(|vault| vault.is_some()))
                                .unwrap_or(false);
                            if !unlocked {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                                let _ = app.emit("quick-capture-locked", ());
                                return;
                            }
                            if let Some(window) = app.get_webview_window("quick-capture") {
                                let _ = window.show();
                                let _ = window.set_focus();
                                return;
                            }
                            let _ = WebviewWindowBuilder::new(
                                app,
                                "quick-capture",
                                WebviewUrl::App("index.html?quick-capture=1".into()),
                            )
                            .title("Quick Capture — Secure Note Vault")
                            .inner_size(520.0, 440.0)
                            .min_inner_size(420.0, 340.0)
                            .resizable(true)
                            .always_on_top(true)
                            .center()
                            .build();
                        })
                        .build(),
                )?;
                // A conflicting system shortcut must not prevent the vault from starting.
                let _ = app.global_shortcut().register(capture_shortcut);
            }
            let new_note =
                MenuItem::with_id(app, "new-note", "New Note", true, Some("CmdOrCtrl+N"))?;
            let lock =
                MenuItem::with_id(app, "lock-vault", "Lock Vault", true, Some("CmdOrCtrl+L"))?;
            let show = MenuItem::with_id(
                app,
                "show-window",
                "Show Secure Note Vault",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&show, &new_note, &lock, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Secure Note Vault");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "new-note" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let unlocked = app
                        .try_state::<VaultState>()
                        .and_then(|state| state.0.lock().ok().map(|vault| vault.is_some()))
                        .unwrap_or(false);
                    if unlocked {
                        let _ = app.emit("new-note-requested", ());
                    }
                }
                "lock-vault" => {
                    if let Some(state) = app.try_state::<VaultState>() {
                        if let Ok(mut vault) = state.0.lock() {
                            *vault = None;
                        }
                    }
                    let _ = app.emit("vault-locked", "menu-bar");
                }
                "show-window" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            create_vault,
            unlock_vault,
            lock_vault,
            save_note,
            note_versions,
            restore_note_version,
            add_attachment,
            list_attachments,
            export_attachment,
            remove_attachment,
            preview_attachment,
            recognize_attachment_text,
            import_note_files,
            export_note_markdown,
            export_shared_note,
            import_shared_note,
            list_saved_searches,
            save_search,
            delete_saved_search,
            security_diagnostics,
            delete_note,
            restore_note,
            permanent_delete_note,
            change_password,
            generate_recovery_key,
            recovery_key_status,
            recover_vault,
            create_backup,
            validate_backup,
            restore_backup,
            enable_pin_unlock,
            enable_biometric_unlock,
            unlock_pin,
            unlock_biometric,
            quick_unlock_status,
            disable_quick_unlock,
            copy_secret,
            activity_timestamps,
            sync_reminders
        ])
        .build(tauri::generate_context!())
        .expect("error while building Secure Note Vault")
        .run(
            |app: &tauri::AppHandle<tauri::Wry>, event: tauri::RunEvent| {
                if matches!(event, tauri::RunEvent::Resumed | tauri::RunEvent::Exit) {
                    if let Some(state) = app.try_state::<VaultState>() {
                        if let Ok(mut vault) = state.0.lock() {
                            *vault = None;
                        }
                    }
                    if matches!(event, tauri::RunEvent::Resumed) {
                        let _ = app.emit("vault-locked", "system-resume");
                    }
                }
            },
        );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_data() -> VaultData {
        VaultData {
            notes: vec![Note {
                id: "note-1".into(),
                title: "Private title".into(),
                content: "known secret text".into(),
                created_at: "1".into(),
                updated_at: "1".into(),
                folder: Some("personal".into()),
                tags: vec!["test".into()],
                pinned: true,
                archived: false,
                deleted_at: None,
            }],
        }
    }

    #[test]
    fn encrypted_payload_round_trips() {
        let data = sample_data();
        let (envelope, _, _) = encrypt(&data, "correct horse battery").expect("encrypt");
        let (decoded, _, _) = decrypt(&envelope, "correct horse battery").expect("decrypt");
        assert_eq!(decoded.notes[0].content, "known secret text");
    }

    #[test]
    fn wrong_password_and_tampering_fail_closed() {
        let (mut envelope, _, _) =
            encrypt(&sample_data(), "correct horse battery").expect("encrypt");
        assert!(decrypt(&envelope, "wrong password").is_err());
        envelope.ciphertext[0] ^= 1;
        assert!(decrypt(&envelope, "correct horse battery").is_err());
    }

    #[test]
    fn serialized_envelope_does_not_contain_plaintext() {
        let (envelope, _, _) = encrypt(&sample_data(), "correct horse battery").expect("encrypt");
        let raw = serde_json::to_vec(&envelope).expect("serialize");
        assert!(!String::from_utf8_lossy(&raw).contains("known secret text"));
    }

    #[test]
    fn password_change_reencrypts_data() {
        let (old_envelope, data_key, _) = encrypt(&sample_data(), "old password").expect("encrypt");
        let (data, _, _) = decrypt(&old_envelope, "old password").expect("decrypt old");
        let new_password_key = derive_key(
            "new password",
            &[9u8; 16],
            ARGON_MEMORY_KIB,
            ARGON_TIME,
            ARGON_LANES,
        )
        .expect("new password key");
        let new_envelope = encrypt_with_key(
            &data,
            &data_key,
            &new_password_key,
            &[9u8; 16],
            ARGON_MEMORY_KIB,
            ARGON_TIME,
            ARGON_LANES,
        )
        .expect("encrypt new");
        assert!(decrypt(&new_envelope, "old password").is_err());
        let (_, rewrapped_data_key, _) =
            decrypt(&new_envelope, "new password").expect("decrypt new");
        assert_eq!(data_key.as_slice(), rewrapped_data_key.as_slice());
    }

    #[test]
    fn backup_authentication_rejects_tampering() {
        let key = [3u8; 32];
        let (nonce, mut ciphertext) =
            encrypt_bytes(&key, b"vault header and database").expect("encrypt backup");
        ciphertext[0] ^= 1;
        assert!(decrypt_bytes(&key, &nonce, &ciphertext).is_err());
    }

    #[test]
    fn recovery_wrapper_restores_the_data_key() {
        let recovery_key = [6u8; 32];
        let data_key = [9u8; 32];
        let (nonce, wrapped) = encrypt_bytes(&recovery_key, &data_key).expect("wrap data key");
        let restored = decrypt_bytes(&recovery_key, &nonce, &wrapped).expect("recover data key");
        assert_eq!(restored, data_key);
        assert!(decrypt_bytes(&[7u8; 32], &nonce, &wrapped).is_err());
    }

    #[test]
    fn encrypted_shared_note_round_trips_without_plaintext() {
        let key = [4u8; 32];
        let note = sample_data().notes.remove(0);
        let (nonce, ciphertext) =
            encrypt_bytes(&key, &serde_json::to_vec(&note).expect("serialize note"))
                .expect("encrypt shared note");
        assert!(!String::from_utf8_lossy(&ciphertext).contains("known secret text"));
        let decoded: Note = serde_json::from_slice(
            &decrypt_bytes(&key, &nonce, &ciphertext).expect("decrypt shared note"),
        )
        .expect("decode note");
        assert_eq!(decoded.content, note.content);
    }

    #[test]
    fn database_survives_password_rewrap_without_rekeying() {
        let path = std::env::temp_dir().join(format!("secure-note-lifecycle-{}.db", timestamp()));
        let data = sample_data();
        let (envelope, data_key, _) = encrypt(&data, "old password").expect("create vault");
        let connection = database::open(&path, &data_key).expect("open database");
        database::save_note(&connection, &data.notes[0]).expect("save note");
        drop(connection);

        let new_password_key = derive_key(
            "new password",
            &[4u8; 16],
            ARGON_MEMORY_KIB,
            ARGON_TIME,
            ARGON_LANES,
        )
        .expect("derive new wrapping key");
        let rewrapped = encrypt_with_key(
            &data,
            &data_key,
            &new_password_key,
            &[4u8; 16],
            ARGON_MEMORY_KIB,
            ARGON_TIME,
            ARGON_LANES,
        )
        .expect("rewrap envelope");
        let (restored, restored_data_key, _) =
            decrypt(&rewrapped, "new password").expect("unlock rewrapped vault");
        assert_eq!(restored.notes[0].content, data.notes[0].content);
        assert_eq!(restored_data_key.as_slice(), data_key.as_slice());
        let connection = database::open(&path, &restored_data_key).expect("reopen database");
        assert_eq!(
            database::load_notes(&connection).expect("load notes").len(),
            1
        );
        drop(connection);
        let _ = envelope;
        std::fs::remove_file(path).expect("remove lifecycle database");
    }

    #[test]
    fn corrupted_database_is_rejected() {
        let path = std::env::temp_dir().join(format!("secure-note-corrupt-{}.db", timestamp()));
        std::fs::write(&path, b"not a database").expect("write corrupt database");
        assert!(database::open(&path, &[8u8; 32]).is_err());
        std::fs::remove_file(path).expect("remove corrupt database");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apple_vision_bridge_accepts_image_data() {
        let image = include_bytes!("../icons/vault-icon-source.png");
        assert!(recognize_image_text(image).is_ok());
    }
}
