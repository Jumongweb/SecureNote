import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  activityTimestamps, addAttachment, Attachment, AttachmentPreview, BackupInfo, changePassword, copySecret, createBackup, createVault,
  deleteNote, deleteSavedSearch, disableQuickUnlock, enableBiometricUnlock, enablePinUnlock,
  exportAttachment, exportNoteMarkdown, exportSharedNote, generateRecoveryKey, importNoteFiles,
  importSharedNote, listAttachments, listSavedSearches, lockVault, Note, NoteVersion, noteVersions,
  permanentDeleteNote, previewAttachment, quickUnlockStatus, recoverVault, recoveryKeyStatus,
  recognizeAttachmentText, removeAttachment, restoreBackup, restoreNote, restoreNoteVersion, saveNote, saveSearch, SavedSearch,
  securityDiagnostics, SecurityDiagnostics, unlockBiometric, unlockPin, unlockVault, validateBackup,
  syncReminders, vaultStatus,
} from "./api";
import { askVault, relatedNotes, semanticSearch, suggestTags, summarizeNote, VaultAnswer } from "./intelligence";
import { CollectionView, ViewSwitcher, WorkspaceView } from "./WorkspaceViews";
import ActionCenter from "./ActionCenter";
import { extractTasks, setTaskCompleted, taskLine, taskReminderRequests, TaskPriority, VaultTask } from "./tasks";
import MarkdownPreview from "./MarkdownPreview";
import { AppearanceMode, infoPanelPreference, nextAppearance } from "./preferences";

type View = "all" | "recent" | "pinned" | "archive" | "trash";
type AuthMethod = "password" | "pin" | "biometric" | "recovery";
type AuthState = "idle" | "waiting" | "success" | "failure" | "cancelled";
type CredentialRecord = { username: string; password: string; url: string; apiKey: string; notes: string };
type Settings = { autoLockMinutes: number; theme: AppearanceMode; privacyBlur: boolean; lockOnBlur: boolean; backupPath?: string; backupIntervalDays: number; lastBackupAt?: string; fontScale: number; editorWidth: "compact" | "wide"; reducedMotion: boolean; highContrast: boolean };

const defaultSettings: Settings = { autoLockMinutes: 5, theme: "dark", privacyBlur: true, lockOnBlur: false, backupIntervalDays: 0, fontScale: 115, editorWidth: "wide", reducedMotion: false, highContrast: false };
const blank = (): Note => ({
  id: crypto.randomUUID(),
  title: "",
  content: "",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  tags: [],
  pinned: false,
  archived: false,
});
const loadSettings = (): Settings => {
  try {
    const stored = JSON.parse(localStorage.getItem("secure-note-settings") ?? "{}");
    return { ...defaultSettings, ...stored, fontScale: stored.fontScale === 100 || stored.fontScale === undefined ? 115 : stored.fontScale };
  } catch {
    return defaultSettings;
  }
};
const errorText = (error: unknown, context?: "pin" | "biometric") => {
  const message = String(error).replace(/^Error:\s*/, "");
  if (context === "biometric" && message.includes("required entitlement")) {
    return "Touch ID requires the signed macOS app. Open the release .app instead of the development window.";
  }
  if (message.includes("quick unlock is unavailable or invalid")) {
    return context === "pin"
      ? "That PIN is incorrect or the PIN unlock data is unavailable."
      : "Touch ID is unavailable, was canceled, or needs to be enabled again.";
  }
  return message;
};
const asDate = (value: string) => new Date(/^\d+$/.test(value) ? Number(value) : value);
const shortDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(asDate(value));
const fullDate = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(asDate(value));
const wordCount = (value: string) => value.trim() ? value.trim().split(/\s+/).length : 0;
const emptyCredential = (): CredentialRecord => ({ username: "", password: "", url: "", apiKey: "", notes: "" });
const isCredential = (note?: Note) => Boolean(note?.tags.some((tag) => tag.toLowerCase() === "credential"));
const credentialData = (note?: Note): CredentialRecord => {
  if (!isCredential(note)) return emptyCredential();
  try { return { ...emptyCredential(), ...JSON.parse(note?.content ?? "{}") }; }
  catch { return emptyCredential(); }
};
const randomPassword = (length = 24) => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_+";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
};

function LockGlyph() {
  return <span className="lock-glyph" aria-hidden="true"><span /></span>;
}

function InfoSection({ title, badge, children, defaultOpen = true }: { title: string; badge?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <section className={`info-collapsible ${open ? "open" : ""}`}><button className="info-section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}><span>{open ? "⌄" : "›"}</span><h3>{title}</h3>{badge && <b>{badge}</b>}</button>{open && <div className="info-section-body">{children}</div>}</section>;
}

function matchesQuery(note: Note, rawQuery: string) {
  const terms = rawQuery.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return terms.every((raw) => {
    const term = raw.replace(/^"|"$/g, "").toLowerCase();
    if (term.startsWith("tag:")) return note.tags.some((tag) => tag.toLowerCase() === term.slice(4));
    if (term.startsWith("folder:")) return (note.folder ?? "").toLowerCase() === term.slice(7);
    if (term === "is:pinned") return note.pinned;
    if (term === "is:archived") return note.archived;
    if (term.startsWith("after:")) return asDate(note.updated_at) >= new Date(term.slice(6));
    if (term.startsWith("before:")) return asDate(note.updated_at) <= new Date(term.slice(7));
    return `${note.title} ${note.content} ${note.folder ?? ""} ${note.tags.join(" ")}`.toLowerCase().includes(term);
  });
}

export default function App() {
  const [status, setStatus] = useState<"checking" | "not-created" | "locked" | "unlocked">("checking");
  const [password, setPassword] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<string>();
  const [authMethod, setAuthMethod] = useState<AuthMethod>("password");
  const [authState, setAuthState] = useState<AuthState>("idle");
  const [unlockPinCode, setUnlockPinCode] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("all");
  const [screen, setScreen] = useState<"dashboard" | "notes" | "settings">("notes");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("list");
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [error, setError] = useState("");
  const [quickUnlock, setQuickUnlock] = useState<[boolean, boolean]>([false, false]);
  const [setupMaster, setSetupMaster] = useState("");
  const [setupPinCode, setSetupPinCode] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [dirtyNoteId, setDirtyNoteId] = useState<string>();
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved" | "failed">("saved");
  const [editorMode, setEditorMode] = useState<"write" | "preview">("write");
  const [sortBy, setSortBy] = useState<"updated" | "created" | "title">("updated");
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [obscured, setObscured] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [recoveryEnabled, setRecoveryEnabled] = useState(false);
  const [recoveryCodeInput, setRecoveryCodeInput] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [generatedRecoveryCode, setGeneratedRecoveryCode] = useState("");
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview>();
  const [backupInfo, setBackupInfo] = useState<BackupInfo>();
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [diagnostics, setDiagnostics] = useState<SecurityDiagnostics>();
  const [intelligenceOpen, setIntelligenceOpen] = useState(false);
  const [intelligenceQuestion, setIntelligenceQuestion] = useState("");
  const [vaultAnswer, setVaultAnswer] = useState<VaultAnswer>();
  const [ocrResult, setOcrResult] = useState<{ name: string; text: string; lineCount: number }>();
  const [ocrBusyId, setOcrBusyId] = useState<string>();
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [activityLog, setActivityLog] = useState<string[]>([]);
  const [infoPanelOpen, setInfoPanelOpen] = useState(() => infoPanelPreference(localStorage.getItem("secure-note-info-panel")));
  const [foldersOpen, setFoldersOpen] = useState(true);
  const [tagsOpen, setTagsOpen] = useState(true);
  const [intelligenceBusy, setIntelligenceBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const editRevision = useRef(0);
  const nativeDialogOpen = useRef(false);
  const current = notes.find((note) => note.id === selected);

  useEffect(() => {
    vaultStatus().then(setStatus).catch(() => setStatus("not-created"));
    quickUnlockStatus().then((methods) => {
      setQuickUnlock(methods);
      if (methods[1]) setAuthMethod("biometric");
      else if (methods[0]) setAuthMethod("pin");
    }).catch(() => setQuickUnlock([false, false]));
    recoveryKeyStatus().then(setRecoveryEnabled).catch(() => setRecoveryEnabled(false));
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.motion = settings.reducedMotion ? "reduced" : "full";
    document.documentElement.dataset.contrast = settings.highContrast ? "high" : "normal";
    document.documentElement.dataset.editorWidth = settings.editorWidth;
    document.documentElement.style.setProperty("--font-scale", `${settings.fontScale / 100}`);
    localStorage.setItem("secure-note-settings", JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    localStorage.setItem("secure-note-info-panel", infoPanelOpen ? "open" : "closed");
  }, [infoPanelOpen]);
  useEffect(() => {
    if (status !== "unlocked" || settings.autoLockMinutes === 0) return;
    let timer = window.setTimeout(() => void doLock(), settings.autoLockMinutes * 60000);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void doLock(), settings.autoLockMinutes * 60000);
    };
    window.addEventListener("mousemove", reset);
    window.addEventListener("keydown", reset);
    window.addEventListener("pointerdown", reset);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousemove", reset);
      window.removeEventListener("keydown", reset);
      window.removeEventListener("pointerdown", reset);
    };
  }, [status, settings.autoLockMinutes]);
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let unlistenNewNote: UnlistenFn | undefined;
    let unlistenSaved: UnlistenFn | undefined;
    let unlistenQuickLocked: UnlistenFn | undefined;
    listen<string>("vault-locked", () => {
      setStatus("locked"); clearSensitiveUi(); setScreen("notes"); setError("The vault was locked and decrypted view state was cleared.");
    }).then((dispose) => { unlisten = dispose; });
    listen("new-note-requested", () => createNote()).then((dispose) => { unlistenNewNote = dispose; });
    listen<Note>("note-saved", (event) => {
      setNotes((all) => all.some((note) => note.id === event.payload.id) ? all.map((note) => note.id === event.payload.id ? event.payload : note) : [event.payload, ...all]);
      void activityTimestamps().then(setActivityLog).catch(() => undefined);
    }).then((dispose) => { unlistenSaved = dispose; });
    listen("quick-capture-locked", () => setError("Unlock the vault before using Quick Capture." )).then((dispose) => { unlistenQuickLocked = dispose; });
    return () => { unlisten?.(); unlistenNewNote?.(); unlistenSaved?.(); unlistenQuickLocked?.(); };
  }, []);
  useEffect(() => {
    if (status !== "unlocked") { setSavedSearches([]); setDiagnostics(undefined); return; }
    listSavedSearches().then(setSavedSearches).catch(() => setSavedSearches([]));
    securityDiagnostics().then(setDiagnostics).catch(() => setDiagnostics(undefined));
    activityTimestamps().then(setActivityLog).catch(() => setActivityLog([]));
  }, [status]);
  useEffect(() => {
    if (status !== "unlocked") return;
    const timer = window.setTimeout(() => {
      void syncReminders(taskReminderRequests(extractTasks(notes))).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [notes, status]);
  useEffect(() => {
    const hide = () => {
      if (status !== "unlocked" || nativeDialogOpen.current) return;
      if (settings.lockOnBlur) void doLock();
      else if (settings.privacyBlur) setObscured(true);
    };
    const reveal = () => setObscured(false);
    window.addEventListener("blur", hide);
    window.addEventListener("focus", reveal);
    return () => { window.removeEventListener("blur", hide); window.removeEventListener("focus", reveal); };
  }, [status, settings.lockOnBlur, settings.privacyBlur]);
  useEffect(() => {
    if (!dirtyNoteId || status !== "unlocked") return;
    const note = notes.find((item) => item.id === dirtyNoteId);
    if (!note) return;
    const timer = window.setTimeout(() => void persistNote(note, false).catch(() => undefined), 900);
    return () => window.clearTimeout(timer);
  }, [dirtyNoteId, notes, status]);
  useEffect(() => {
    if (!selected || status !== "unlocked") { setVersions([]); setAttachments([]); return; }
    void refreshNoteExtras(selected);
  }, [selected, status]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setCommandOpen(false); setCommandQuery(""); return; }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(true); }
      if (event.key.toLowerCase() === "f") { event.preventDefault(); setScreen("notes"); window.setTimeout(() => searchRef.current?.focus(), 0); }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); createNote(); }
      if (event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      if (event.key.toLowerCase() === "l") { event.preventDefault(); void doLock(); }
      if (event.key === "\\") { event.preventDefault(); setInfoPanelOpen((open) => !open); }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  useEffect(() => {
    if (status !== "unlocked" || !settings.backupPath || settings.backupIntervalDays === 0) return;
    const previous = settings.lastBackupAt ? new Date(settings.lastBackupAt).getTime() : 0;
    if (Date.now() - previous < settings.backupIntervalDays * 86400000) return;
    void createBackup(settings.backupPath).then(() => {
      setSettings((value) => ({ ...value, lastBackupAt: new Date().toISOString() }));
      setError("Scheduled encrypted backup completed.");
    }).catch((reason) => setError(errorText(reason)));
  }, [status, settings.backupPath, settings.backupIntervalDays, settings.lastBackupAt]);
  useEffect(() => {
    setRevealedSecrets(new Set());
  }, [selected]);
  useEffect(() => {
    if (!revealedSecrets.size) return;
    const timer = window.setTimeout(() => setRevealedSecrets(new Set()), 20000);
    return () => window.clearTimeout(timer);
  }, [revealedSecrets]);

  function clearSensitiveUi() {
    setNotes([]); setSelected(undefined); setVersions([]); setAttachments([]);
    setAttachmentPreview(undefined); setOcrResult(undefined); setOcrBusyId(undefined);
    setVaultAnswer(undefined); setIntelligenceQuestion(""); setIntelligenceOpen(false);
    setGeneratedRecoveryCode(""); setRecoveryCodeInput(""); setRecoveryPassword("");
    setSetupMaster(""); setSetupPinCode(""); setOldPassword(""); setNewPassword(""); setConfirmPassword("");
    setPassword(""); setUnlockPinCode(""); setRevealedSecrets(new Set()); setCommandOpen(false); setActivityLog([]); setAuthState("idle"); setIntelligenceBusy(false);
  }

  async function doLock() {
    await lockVault();
    setStatus("locked");
    clearSensitiveUi();
    setScreen("notes");
    setError("");
  }
  function cycleTheme() {
    setSettings((value) => ({ ...value, theme: nextAppearance(value.theme) }));
  }
  async function nativeDialog<T>(operation: () => Promise<T>): Promise<T> {
    nativeDialogOpen.current = true;
    try { return await operation(); }
    finally { nativeDialogOpen.current = false; }
  }
  function openNotes(result: Note[]) {
    setAuthState("success");
    setStatus("unlocked");
    setNotes(result);
    setSelected(result.find((note) => !note.deleted_at)?.id);
    setScreen("dashboard");
    setPassword("");
    setUnlockPinCode("");
    setError("");
  }
  async function authenticate(action: "create" | "unlock") {
    setError("");
    setAuthState("waiting");
    try {
      if (action === "create") {
        await createVault(password);
        openNotes([]);
      } else {
        openNotes(await unlockVault(password));
      }
    } catch (e) {
      setError(errorText(e));
      setAuthState("failure");
    }
  }
  async function quickAuthenticate(kind: "pin" | "biometric") {
    setError("");
    if (kind === "pin" && !/^\d{6}$/.test(unlockPinCode)) {
      setError("Enter your six-digit vault PIN.");
      setAuthState("failure");
      return;
    }
    setAuthState("waiting");
    try {
      openNotes(kind === "pin" ? await unlockPin(unlockPinCode) : await unlockBiometric());
    } catch (e) {
      const message = errorText(e, kind);
      setError(message);
      setAuthState(/cancel/i.test(message) ? "cancelled" : "failure");
    }
  }
  async function recoverWithKey() {
    if (recoveryCodeInput.replace(/-/g, "").length !== 64 || recoveryPassword.length < 8) { setError("Enter the complete recovery key and a new password of at least 8 characters."); return; }
    try {
      openNotes(await recoverVault(recoveryCodeInput, recoveryPassword));
      setQuickUnlock([false, false]); setRecoveryCodeInput(""); setRecoveryPassword("");
      setError("Vault recovered. PIN and Touch ID were disabled.");
    } catch (e) { setError(errorText(e)); }
  }
  async function createRecoveryKey() {
    if (!setupMaster) { setError("Enter your master password first."); return; }
    try {
      const code = await generateRecoveryKey(setupMaster);
      setGeneratedRecoveryCode(code); setRecoveryEnabled(true); setSetupMaster("");
      setError("Recovery key generated. Save it now—it will not be shown again.");
    } catch (e) { setError(errorText(e)); }
  }
  async function refreshNoteExtras(noteId: string) {
    const [history, files] = await Promise.all([noteVersions(noteId), listAttachments(noteId)]);
    setVersions(history); setAttachments(files);
  }
  async function persistNote(note: Note, announce: boolean) {
    const revision = editRevision.current;
    setSaveState("saving");
    try {
      const saved = await saveNote({ ...note, updated_at: new Date().toISOString() });
      if (revision === editRevision.current) {
        setNotes((all) => all.some((item) => item.id === saved.id) ? all.map((item) => item.id === saved.id ? saved : item) : [saved, ...all]);
        setDirtyNoteId(undefined);
        setSaveState("saved");
      }
      if (selected === saved.id) void refreshNoteExtras(saved.id);
      if (announce) setError("Saved securely.");
      return saved;
    } catch (e) {
      setSaveState("failed");
      setError(errorText(e));
      throw e;
    }
  }
  async function save() {
    if (!current) return;
    try { await persistNote(current, true); }
    catch { /* persistNote already exposes the failed state and safe error message. */ }
  }
  async function backup() {
    try {
      const path = await nativeDialog(() => saveDialog({ defaultPath: "secure-note-vault.snvb", filters: [{ name: "Encrypted vault backup", extensions: ["snvb"] }] }));
      if (path) {
        setError(`Encrypted backup created: ${await createBackup(path)}`);
        setSettings((value) => ({ ...value, lastBackupAt: new Date().toISOString() }));
      }
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function configureAutomaticBackup() {
    const path = await nativeDialog(() => saveDialog({ defaultPath: "secure-note-vault-auto.snvb", filters: [{ name: "Encrypted vault backup", extensions: ["snvb"] }] }));
    if (!path) return;
    try {
      await createBackup(path);
      setSettings((value) => ({ ...value, backupPath: path, backupIntervalDays: value.backupIntervalDays || 7, lastBackupAt: new Date().toISOString() }));
      setError("Automatic encrypted backup location configured.");
    } catch (e) { setError(errorText(e)); }
  }
  async function restore() {
    const path = await nativeDialog(() => open({ multiple: false, directory: false, filters: [{ name: "Encrypted vault backup", extensions: ["snvb"] }] }));
    if (typeof path !== "string") return;
    const pass = window.prompt("Backup password:");
    if (!pass) return;
    try {
      const info = await validateBackup(path, pass);
      setBackupInfo(info);
      const created = info.created_at ? fullDate(info.created_at) : "an earlier app version";
      if (!window.confirm(`Valid encrypted backup from ${created}.\n\n${info.note_count} notes and ${info.attachment_count} attachments.\n\nRestore it and replace the active vault?`)) return;
      openNotes(await restoreBackup(path, pass));
      setQuickUnlock([false, false]); setRecoveryEnabled(false);
      setError("Backup restored.");
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function submitPasswordChange() {
    if (newPassword.length < 8 || newPassword !== confirmPassword) {
      setError("New passwords must match and contain at least 8 characters.");
      return;
    }
    try {
      await changePassword(oldPassword, newPassword);
      setOldPassword(""); setNewPassword(""); setConfirmPassword("");
      setQuickUnlock([false, false]);
      setError("Master password changed; quick unlocks were disabled.");
    } catch (e) { setError(errorText(e)); }
  }
  async function setupPin() {
    if (!setupMaster || !/^\d{6}$/.test(setupPinCode)) {
      setError("Enter your master password and a six-digit PIN.");
      return;
    }
    try {
      await enablePinUnlock(setupMaster, setupPinCode);
      setSetupMaster(""); setSetupPinCode("");
      setQuickUnlock([true, quickUnlock[1]]);
      setError("PIN unlock enabled.");
    } catch (e) { setError(errorText(e)); }
  }
  async function setupBiometric() {
    if (!setupMaster) { setError("Enter your master password first."); return; }
    try {
      await enableBiometricUnlock(setupMaster);
      setSetupMaster(""); setQuickUnlock([quickUnlock[0], true]);
      setError("Touch ID unlock enabled.");
    } catch (e) { setError(errorText(e, "biometric")); }
  }
  async function disableUnlocks() {
    const master = window.prompt("Master password:");
    if (!master) return;
    try {
      await disableQuickUnlock(master);
      setQuickUnlock([false, false]);
      setError("Quick unlocks disabled.");
    } catch (e) { setError(errorText(e)); }
  }
  function updateNote(update: Partial<Note>) {
    if (current) {
      editRevision.current += 1;
      setDirtyNoteId(current.id);
      setSaveState("unsaved");
      setNotes((all) => all.map((note) => note.id === current.id ? { ...note, ...update } : note));
    }
  }
  function createNote() {
    const note = blank();
    setNotes((all) => [note, ...all]);
    setSelected(note.id);
    setScreen("notes");
    setView("all");
    setQuery("");
    editRevision.current += 1;
    setDirtyNoteId(note.id);
    setSaveState("unsaved");
  }
  function openCollectionNote(note: Note) {
    setSelected(note.id); setScreen("notes"); setWorkspaceView("list"); setView("all");
  }
  function openInternalLink(title: string) {
    const linked = notes.find((note) => note.title.toLowerCase() === title.toLowerCase());
    if (linked) setSelected(linked.id);
    else setError(`No note named “${title}” was found.`);
  }
  async function completeActionTask(task: VaultTask) {
    const source = notes.find((note) => note.id === task.noteId);
    if (!source) return;
    const updated = { ...source, content: setTaskCompleted(source.content, task.lineIndex), updated_at: new Date().toISOString() };
    setNotes((all) => all.map((note) => note.id === updated.id ? updated : note));
    try {
      const saved = await saveNote(updated);
      setNotes((all) => all.map((note) => note.id === saved.id ? saved : note));
      setActivityLog(await activityTimestamps());
    } catch (e) { setError(errorText(e)); }
  }
  async function createQuickTask(text: string, dueDate: string, priority: TaskPriority) {
    const existing = notes.find((note) => !note.deleted_at && note.tags.includes("action-inbox"));
    const line = taskLine(text, dueDate, priority);
    const note = existing
      ? { ...existing, content: `${existing.content.trimEnd()}\n${line}\n`, updated_at: new Date().toISOString() }
      : { ...blank(), title: "Action Inbox", content: `# Action Inbox\n\n${line}\n`, folder: "Planning", tags: ["action-inbox"] };
    setNotes((all) => existing ? all.map((item) => item.id === note.id ? note : item) : [note, ...all]);
    try {
      const saved = await saveNote(note);
      setNotes((all) => all.map((item) => item.id === saved.id ? saved : item));
      setActivityLog(await activityTimestamps());
    } catch (e) { setError(errorText(e)); }
  }
  async function moveKanbanNote(note: Note, stage: string) {
    const stageTags = new Set(["todo", "doing", "done"]);
    const updated = { ...note, tags: [...note.tags.filter((tag) => !stageTags.has(tag)), stage], updated_at: new Date().toISOString() };
    setNotes((all) => all.map((item) => item.id === note.id ? updated : item));
    try { await saveNote(updated); }
    catch (e) { setError(errorText(e)); }
  }
  function createCredential() {
    const note = { ...blank(), title: "New credential", content: JSON.stringify(emptyCredential()), tags: ["credential"], folder: "Secrets" };
    setNotes((all) => [note, ...all]); setSelected(note.id); setScreen("notes"); setWorkspaceView("list"); setView("all"); setQuery("");
    editRevision.current += 1; setDirtyNoteId(note.id); setSaveState("unsaved"); setCommandOpen(false);
  }
  function updateCredential(field: keyof CredentialRecord, value: string) {
    if (!current) return;
    updateNote({ content: JSON.stringify({ ...credentialData(current), [field]: value }) });
  }
  function toggleSecret(field: string) {
    setRevealedSecrets((visible) => { const next = new Set(visible); next.has(field) ? next.delete(field) : next.add(field); return next; });
  }
  async function copyProtected(value: string, label: string) {
    if (!value) return;
    try { await copySecret(value); setError(`${label} copied. It will clear from the clipboard after 30 seconds.`); }
    catch (e) { setError(errorText(e)); }
  }
  function createFromTemplate(kind: "meeting" | "journal" | "project" | "checklist") {
    const templates = {
      meeting: { title: "Meeting notes", content: "# Meeting\n\n**Date:**\n**Attendees:**\n\n## Agenda\n- \n\n## Decisions\n- \n\n## Action items\n- [ ] ", tags: ["meeting"] },
      journal: { title: new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date()), content: "# Daily journal\n\n## What happened\n\n## What I learned\n\n## Tomorrow\n- [ ] ", tags: ["journal"] },
      project: { title: "Project brief", content: "# Project\n\n## Goal\n\n## Milestones\n- [ ] \n\n## Notes\n", tags: ["project"] },
      checklist: { title: "Checklist", content: "# Checklist\n\n- [ ] First item\n- [ ] Second item\n", tags: ["checklist"] },
    };
    const base = blank(); const template = templates[kind]; const note = { ...base, ...template };
    setNotes((all) => [note, ...all]); setSelected(note.id); setScreen("notes"); setView("all"); setQuery("");
    editRevision.current += 1; setDirtyNoteId(note.id); setSaveState("unsaved"); setCommandOpen(false);
  }
  function openDailyNote() {
    const today = new Date().toISOString().slice(0, 10);
    const existing = notes.find((note) => note.tags.includes("daily") && note.created_at.slice(0, 10) === today);
    if (existing) { setSelected(existing.id); setScreen("notes"); setCommandOpen(false); return; }
    const note = { ...blank(), title: new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(new Date()), content: "# Daily note\n\n## Focus\n\n- [ ] \n\n## Notes\n", tags: ["daily"] };
    setNotes((all) => [note, ...all]); setSelected(note.id); setScreen("notes"); editRevision.current += 1; setDirtyNoteId(note.id); setSaveState("unsaved"); setCommandOpen(false);
  }
  async function attachFile() {
    if (!current) return;
    try {
      await persistNote(current, false);
      const path = await nativeDialog(() => open({ multiple: false, directory: false }));
      if (typeof path !== "string") return;
      const attachment = await addAttachment(current.id, path, new Date().toISOString());
      setAttachments((items) => [attachment, ...items]);
      setError(`${attachment.name} attached securely.`);
    } catch (e) { setError(errorText(e)); }
  }
  async function saveAttachmentFile(attachment: Attachment) {
    const destination = await nativeDialog(() => saveDialog({ defaultPath: attachment.name }));
    if (!destination) return;
    try { await exportAttachment(attachment.id, destination); setError(`Attachment exported: ${destination}`); }
    catch (e) { setError(errorText(e)); }
  }
  async function deleteAttachmentFile(attachment: Attachment) {
    if (!window.confirm(`Remove ${attachment.name} from this note?`)) return;
    try { await removeAttachment(attachment.id); setAttachments((items) => items.filter((item) => item.id !== attachment.id)); }
    catch (e) { setError(errorText(e)); }
  }
  async function showAttachment(attachment: Attachment) {
    try { setAttachmentPreview(await previewAttachment(attachment.id)); }
    catch (e) { setError(errorText(e)); }
  }
  async function scanAttachment(attachment: Attachment) {
    setOcrBusyId(attachment.id);
    try {
      const result = await recognizeAttachmentText(attachment.id);
      setOcrResult({ name: attachment.name, text: result.text, lineCount: result.line_count });
    } catch (e) { setError(errorText(e)); }
    finally { setOcrBusyId(undefined); }
  }
  function addOcrToCurrentNote() {
    if (!current || !ocrResult) return;
    const block = `\n\n## Text extracted from ${ocrResult.name}\n\n${ocrResult.text.trim()}\n`;
    updateNote({ content: `${current.content.trimEnd()}${block}` });
    setOcrResult(undefined);
    setError("Recognized text added to the encrypted note.");
  }
  function runVaultQuestion() {
    if (!intelligenceQuestion.trim()) return;
    setIntelligenceBusy(true);
    window.setTimeout(() => {
      setVaultAnswer(askVault(notes.filter((note) => !note.deleted_at), intelligenceQuestion));
      setIntelligenceBusy(false);
    }, 0);
  }
  async function importMarkdown() {
    const chosen = await nativeDialog(() => open({ multiple: true, directory: false, filters: [{ name: "Markdown and text", extensions: ["md", "markdown", "txt"] }] }));
    const paths = typeof chosen === "string" ? [chosen] : chosen;
    if (!paths?.length) return;
    try {
      const imported = await importNoteFiles(paths, new Date().toISOString());
      setNotes((all) => [...imported, ...all]); setSelected(imported[0]?.id); setScreen("notes"); setError(`${imported.length} note${imported.length === 1 ? "" : "s"} imported securely.`);
    } catch (e) { setError(errorText(e)); }
  }
  async function exportMarkdown() {
    if (!current || !window.confirm("This creates an unencrypted Markdown file. Continue?")) return;
    const destination = await nativeDialog(() => saveDialog({ defaultPath: `${current.title || "note"}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] }));
    if (!destination) return;
    try { await exportNoteMarkdown(current.id, destination); setError("Unencrypted Markdown export created."); }
    catch (e) { setError(errorText(e)); }
  }
  async function shareEncrypted() {
    if (!current) return;
    const sharePassword = window.prompt("Create a password of at least 8 characters for this shared note:");
    if (!sharePassword || sharePassword.length < 8) { if (sharePassword) setError("Sharing password must contain at least 8 characters."); return; }
    const destination = await nativeDialog(() => saveDialog({ defaultPath: `${current.title || "shared-note"}.snshare`, filters: [{ name: "Encrypted shared note", extensions: ["snshare"] }] }));
    if (!destination) return;
    try { await exportSharedNote(current.id, destination, sharePassword); setError("Password-protected note exported."); }
    catch (e) { setError(errorText(e)); }
  }
  async function importEncryptedShare() {
    const path = await nativeDialog(() => open({ multiple: false, directory: false, filters: [{ name: "Encrypted shared note", extensions: ["snshare"] }] }));
    if (typeof path !== "string") return;
    const sharePassword = window.prompt("Shared-note password:");
    if (!sharePassword) return;
    try { const note = await importSharedNote(path, sharePassword, new Date().toISOString()); setNotes((all) => [note, ...all]); setSelected(note.id); setScreen("notes"); setError("Encrypted shared note imported."); }
    catch (e) { setError(errorText(e)); }
  }
  async function storeSearch() {
    if (!query.trim()) { setError("Enter a search query first."); return; }
    const name = window.prompt("Name this encrypted saved search:", query);
    if (!name) return;
    try { const saved = await saveSearch(name, query); setSavedSearches((items) => [...items, saved].sort((a, b) => a.name.localeCompare(b.name))); }
    catch (e) { setError(errorText(e)); }
  }
  async function removeSavedSearch(search: SavedSearch) {
    try { await deleteSavedSearch(search.id); setSavedSearches((items) => items.filter((item) => item.id !== search.id)); }
    catch (e) { setError(errorText(e)); }
  }
  async function refreshDiagnostics() {
    try { setDiagnostics(await securityDiagnostics()); setError("Security diagnostics completed."); }
    catch (e) { setError(errorText(e)); }
  }
  async function restoreVersion(version: NoteVersion) {
    if (!window.confirm(`Restore the version saved ${fullDate(version.saved_at)}? The current note will remain in history.`)) return;
    try {
      const restored = await restoreNoteVersion(version.id, new Date().toISOString());
      setNotes((all) => all.map((note) => note.id === restored.id ? restored : note));
      setDirtyNoteId(undefined); setSaveState("saved");
      await refreshNoteExtras(restored.id);
      setError("Previous version restored.");
    } catch (e) { setError(errorText(e)); }
  }

  const activeNotes = notes.filter((note) => !note.deleted_at && !note.archived);
  const folders = useMemo(() => Array.from(new Set(activeNotes.map((note) => note.folder).filter(Boolean) as string[])).slice(0, 5), [notes]);
  const tags = useMemo(() => Array.from(new Set(activeNotes.flatMap((note) => note.tags))).slice(0, 6), [notes]);
  const related = useMemo(() => current ? relatedNotes(notes, current.id) : [], [notes, current?.id]);
  const smartSummary = useMemo(() => current ? summarizeNote(current) : "", [current?.id, current?.content, current?.title]);
  const smartTags = useMemo(() => current ? suggestTags(current, notes) : [], [notes, current?.id, current?.content, current?.title, current?.tags]);
  const visible = useMemo(() => {
    const filtered = notes.filter((note) => {
    const recent = Date.now() - asDate(note.updated_at).getTime() < 7 * 86400000;
    const match = view === "trash" ? Boolean(note.deleted_at)
      : view === "archive" ? !note.deleted_at && note.archived
      : !note.deleted_at && !note.archived && (view === "all" || (view === "pinned" && note.pinned) || (view === "recent" && recent));
    return match;
    });
    const structured = /(?:^|\s)(?:tag:|folder:|is:|after:|before:)/i.test(query);
    if (query.trim() && !structured) return semanticSearch(filtered, query).map((result) => result.note);
    return filtered.filter((note) => matchesQuery(note, query)).sort((left, right) => sortBy === "title" ? left.title.localeCompare(right.title) : asDate(sortBy === "created" ? right.created_at : right.updated_at).getTime() - asDate(sortBy === "created" ? left.created_at : left.updated_at).getTime());
  }, [notes, query, view, sortBy]);

  const commandActions = [
    { icon: "＋", label: "New note", hint: "⌘ N", run: () => createNote() },
    { icon: "✦", label: "Ask Your Vault", hint: "Local", run: () => setIntelligenceOpen(true) },
    { icon: "◷", label: "Open today’s daily note", run: openDailyNote },
    { icon: "▦", label: "New meeting template", run: () => createFromTemplate("meeting") },
    { icon: "▦", label: "New journal template", run: () => createFromTemplate("journal") },
    { icon: "▦", label: "New project template", run: () => createFromTemplate("project") },
    { icon: "▦", label: "New checklist template", run: () => createFromTemplate("checklist") },
    { icon: "✓", label: "Save current note", hint: "⌘ S", disabled: !current, run: () => void save() },
    { icon: "⌕", label: "Advanced search", hint: "⌘ F", run: () => { setScreen("notes"); window.setTimeout(() => searchRef.current?.focus(), 0); } },
    { icon: "◫", label: "Toggle Markdown preview", disabled: !current, run: () => setEditorMode(editorMode === "write" ? "preview" : "write") },
    { icon: "⇥", label: "Import Markdown or text", run: () => void importMarkdown() },
    { icon: "◇", label: "Import encrypted shared note", run: () => void importEncryptedShare() },
    { icon: "◐", label: "Cycle appearance", hint: settings.theme, run: cycleTheme },
    { icon: "⇥", label: "Toggle note information", hint: "⌘ \\", run: () => setInfoPanelOpen((open) => !open) },
    { icon: "⚙", label: "Settings & security", run: () => setScreen("settings") },
    { icon: "⇩", label: "Create encrypted backup", run: () => void backup() },
    { icon: "◇", label: "Lock vault", hint: "⌘ L", danger: true, run: () => void doLock() },
  ].filter((action) => !action.disabled && `${action.label} ${action.hint ?? ""}`.toLowerCase().includes(commandQuery.trim().toLowerCase()));
  const runCommand = (index: number) => {
    const action = commandActions[index];
    if (!action) return;
    action.run();
    setCommandOpen(false);
    setCommandQuery("");
    setCommandIndex(0);
  };

  if (status === "checking") return <main className="gate gate-loading"><div className="gate-shade" /><section className="vault-loader"><span className="loader-mark"><LockGlyph /></span><strong>Secure Note Vault</strong><small>Checking local vault protection…</small><i /></section></main>;

  if (status !== "unlocked") {
    const creating = status === "not-created";
    return <main className="gate">
      <div className="gate-shade" />
      <header className="gate-topbar">
        <div className="gate-brand"><span className="gate-logo"><LockGlyph /></span><div><strong>Secure Note Vault</strong><small>Your notes. Your control.</small></div></div>
        <div className="gate-utilities"><button aria-label="Cycle appearance" title={`Appearance: ${settings.theme}`} onClick={cycleTheme}>☼</button><span>Private · Offline</span></div>
      </header>
      <section className="gate-content">
        <section className="gate-showcase">
          <span className="eyebrow">YOUR PRIVATE WRITING SPACE</span>
          <h2>A private space for your most <em>important thoughts.</em></h2>
          <p>Encrypted locally. Offline by default.<br />Built for privacy, focus, and peace of mind.</p>
          <div className="trust-list">
            <span><i>◇</i><b>End-to-end local encryption<small>Your data stays on your device</small></b></span>
            <span><i>▣</i><b>No cloud required<small>Completely offline and private</small></b></span>
            <span><i>⬡</i><b>Auto-lock for extra security<small>Keeps your notes protected</small></b></span>
          </div>
        </section>
        <section className={`auth-card auth-${authState}`}>
          <div className="auth-icon"><LockGlyph /></div>
          <div className="auth-heading">
            <h1>{creating ? "Create your private vault" : "Welcome back"}</h1>
            <p>{creating ? "Choose a strong master password to begin." : "Unlock your private vault to continue"}</p>
          </div>
          {!creating && <div className="auth-tabs" role="tablist" aria-label="Unlock method">
            <button className={authMethod === "password" ? "active" : ""} onClick={() => { setAuthMethod("password"); setAuthState("idle"); setError(""); }}><LockGlyph /><span>Password</span></button>
            <button className={authMethod === "pin" ? "active" : ""} disabled={!quickUnlock[0]} onClick={() => { setAuthMethod("pin"); setAuthState("idle"); setError(""); }}><b>••••</b><span>PIN</span></button>
            <button className={authMethod === "biometric" ? "active" : ""} disabled={!quickUnlock[1]} onClick={() => { setAuthMethod("biometric"); setAuthState("idle"); setError(""); }}><b className="fingerprint">◎</b><span>Touch ID</span></button>
          </div>}
          {(creating || authMethod === "password") && <div className="auth-form">
            <label><span>{creating ? "Create master password" : "Master password"}</span><div className="input-with-icon"><LockGlyph /><input type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void authenticate(creating ? "create" : "unlock")} placeholder={creating ? "At least 8 characters" : "Enter your master password"} /></div></label>
            <button className="primary-auth" onClick={() => authenticate(creating ? "create" : "unlock")} disabled={password.length < 8 || authState === "waiting"}>{authState === "waiting" ? "Authenticating securely…" : creating ? "Create encrypted vault" : "Unlock vault"}<span>{authState === "waiting" ? "◌" : "→"}</span></button>
          </div>}
          {!creating && authMethod === "pin" && <div className="auth-form">
            <label><span>Six-digit PIN</span><div className="input-with-icon"><b>#</b><input type="password" inputMode="numeric" autoFocus autoComplete="off" maxLength={6} value={unlockPinCode} onChange={(event) => setUnlockPinCode(event.target.value.replace(/\D/g, ""))} onKeyDown={(event) => event.key === "Enter" && void quickAuthenticate("pin")} placeholder="Enter your vault PIN" /></div></label>
            <button className="primary-auth" onClick={() => quickAuthenticate("pin")} disabled={unlockPinCode.length !== 6 || authState === "waiting"}>{authState === "waiting" ? "Verifying PIN…" : "Unlock with PIN"}<span>{authState === "waiting" ? "◌" : "→"}</span></button>
          </div>}
          {!creating && authMethod === "biometric" && <div className={`biometric-panel auth-${authState}`}>
            <span className="biometric-rings"><i /><b>{authState === "success" ? "✓" : authState === "failure" ? "!" : authState === "cancelled" ? "×" : "◎"}</b></span>
            <div><strong>{authState === "waiting" ? "Waiting for Touch ID" : authState === "success" ? "Authenticated" : authState === "failure" ? "Touch ID was not accepted" : authState === "cancelled" ? "Authentication cancelled" : "Ready for Touch ID"}</strong><small>{authState === "waiting" ? "Touch the sensor when macOS asks." : "Use the fingerprint enrolled on this Mac."}</small></div>
            <button className="primary-auth" disabled={authState === "waiting"} onClick={() => quickAuthenticate("biometric")}>{authState === "waiting" ? "Authenticating…" : "Use Touch ID"}<span>{authState === "waiting" ? "◌" : "→"}</span></button>
          </div>}
          {!creating && authMethod === "recovery" && <div className="auth-form recovery-form">
            <label><span>Recovery key</span><textarea autoFocus value={recoveryCodeInput} onChange={(event) => setRecoveryCodeInput(event.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-…" /></label>
            <label><span>New master password</span><div className="input-with-icon"><LockGlyph /><input type="password" value={recoveryPassword} onChange={(event) => setRecoveryPassword(event.target.value)} placeholder="At least 8 characters" /></div></label>
            <button className="primary-auth" onClick={recoverWithKey}>Recover vault<span>→</span></button>
            <button className="auth-text-button" onClick={() => setAuthMethod("password")}>Return to normal unlock</button>
          </div>}
          {!creating && authMethod !== "recovery" && recoveryEnabled && <button className="auth-text-button" onClick={() => { setAuthMethod("recovery"); setError(""); }}>Use recovery key</button>}
          {error && <div className="error auth-error" role="alert"><span>!</span>{error}</div>}
          <div className="recovery-note"><span>⬢</span><small>Your data is encrypted and stored only on this device. Your master password remains the recovery authority.</small></div>
        </section>
      </section>
    </main>;
  }

  const viewTitle = view === "trash" ? "Trash" : view === "archive" ? "Archive" : view === "pinned" ? "Pinned notes" : view === "recent" ? "Recent notes" : "All notes";
  const nav = <nav className="main-nav">
    <button className={screen === "dashboard" ? "active" : ""} onClick={() => setScreen("dashboard")}><span>✦</span>Action Center<b>{extractTasks(notes).filter((task) => !task.completed).length}</b></button>
    <button className={view === "all" && screen === "notes" ? "active" : ""} onClick={() => { setScreen("notes"); setView("all"); setQuery(""); }}><span>▣</span>All notes<b>{activeNotes.length}</b></button>
    <button className={view === "recent" && screen === "notes" ? "active" : ""} onClick={() => { setScreen("notes"); setView("recent"); setQuery(""); }}><span>◷</span>Recent<b>{activeNotes.filter((note) => Date.now() - asDate(note.updated_at).getTime() < 7 * 86400000).length}</b></button>
    <button className={view === "pinned" && screen === "notes" ? "active" : ""} onClick={() => { setScreen("notes"); setView("pinned"); setQuery(""); }}><span>☆</span>Pinned<b>{notes.filter((note) => note.pinned && !note.deleted_at).length}</b></button>
    <button className={view === "archive" && screen === "notes" ? "active" : ""} onClick={() => { setScreen("notes"); setView("archive"); setQuery(""); }}><span>▱</span>Archive<b>{notes.filter((note) => note.archived && !note.deleted_at).length}</b></button>
    <button className={view === "trash" && screen === "notes" ? "active" : ""} onClick={() => { setScreen("notes"); setView("trash"); setQuery(""); }}><span>♲</span>Trash<b>{notes.filter((note) => note.deleted_at).length}</b></button>
  </nav>;

  const settingsPanel = <section className="settings-panel">
    <div className="settings-heading"><span className="eyebrow">VAULT CONTROLS</span><h1>Settings & security</h1><p>Local-only preferences and protected unlock controls.</p></div>
    <div className="settings-grid">
      <div className="setting-card"><span className="setting-icon">◷</span><h3>Automatic locking</h3><p>Lock after inactivity.</p><select value={settings.autoLockMinutes} onChange={(event) => setSettings({ ...settings, autoLockMinutes: Number(event.target.value) })}><option value={1}>1 minute</option><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={0}>Never</option></select><small>{settings.autoLockMinutes === 0 ? "The vault stays open until manually locked." : `Locks after ${settings.autoLockMinutes} minute${settings.autoLockMinutes === 1 ? "" : "s"}.`}</small></div>
      <div className="setting-card"><span className="setting-icon">◐</span><h3>Appearance</h3><p>Choose your local theme.</p><select value={settings.theme} onChange={(event) => setSettings({ ...settings, theme: event.target.value as Settings["theme"] })}><option value="dark">Cinematic Dark</option><option value="light">Minimal Light</option><option value="focus">Focus Mode</option></select><small>Focus Mode removes scenic distraction while keeping every tool available.</small></div>
      <div className="setting-card"><span className="setting-icon success">✓</span><h3>Protection</h3><p><span className="status-dot" /> Unlocked · SQLCipher protected</p><small>Master password remains the recovery authority.</small></div>
      <div className="setting-card privacy-card"><span className="setting-icon">◉</span><h3>Screen privacy</h3><label><span>Blur when inactive</span><input type="checkbox" checked={settings.privacyBlur} onChange={(event) => setSettings({ ...settings, privacyBlur: event.target.checked })} /></label><label><span>Lock when focus is lost</span><input type="checkbox" checked={settings.lockOnBlur} onChange={(event) => setSettings({ ...settings, lockOnBlur: event.target.checked })} /></label><small>The native layer also locks after Mac sleep or resume.</small></div>
      <div className="setting-card accessibility-card"><span className="setting-icon">Aa</span><h3>Accessibility</h3><label><span>Text size</span><select value={settings.fontScale} onChange={(event) => setSettings({ ...settings, fontScale: Number(event.target.value) })}><option value={100}>Compact</option><option value={115}>Default</option><option value={130}>Large</option><option value={145}>Extra large</option></select></label><label><span>Editor width</span><select value={settings.editorWidth} onChange={(event) => setSettings({ ...settings, editorWidth: event.target.value as Settings["editorWidth"] })}><option value="wide">Wide</option><option value="compact">Focused</option></select></label><label><span>Reduce motion</span><input type="checkbox" checked={settings.reducedMotion} onChange={(event) => setSettings({ ...settings, reducedMotion: event.target.checked })} /></label><label><span>High contrast</span><input type="checkbox" checked={settings.highContrast} onChange={(event) => setSettings({ ...settings, highContrast: event.target.checked })} /></label></div>
    </div>
    <div className="settings-card-wide"><div className="settings-card-title"><span className="setting-icon">◎</span><div><h3>Quick unlock</h3><p>Enable convenient local access without weakening your master-password recovery.</p></div><div className="method-status"><span className={quickUnlock[0] ? "on" : ""}>PIN {quickUnlock[0] ? "on" : "off"}</span><span className={quickUnlock[1] ? "on" : ""}>Touch ID {quickUnlock[1] ? "on" : "off"}</span></div></div><div className="form-row"><input type="password" value={setupMaster} onChange={(event) => setSetupMaster(event.target.value)} placeholder="Master password" /><input inputMode="numeric" maxLength={6} value={setupPinCode} onChange={(event) => setSetupPinCode(event.target.value.replace(/\D/g, ""))} placeholder="Six-digit PIN" /><button onClick={setupPin}>Enable PIN</button><button onClick={setupBiometric}>Enable Touch ID</button><button className="danger-button" onClick={disableUnlocks}>Disable</button></div></div>
    <div className="settings-card-wide recovery-card"><div className="settings-card-title"><span className="setting-icon">⌘</span><div><h3>Emergency recovery key</h3><p>Reset a forgotten master password with a separately stored 256-bit recovery secret.</p></div><div className="method-status"><span className={recoveryEnabled ? "on" : ""}>{recoveryEnabled ? "Configured" : "Not configured"}</span></div></div><div className="form-row"><input type="password" value={setupMaster} onChange={(event) => setSetupMaster(event.target.value)} placeholder="Master password" /><button onClick={createRecoveryKey}>{recoveryEnabled ? "Replace recovery key" : "Generate recovery key"}</button></div>{generatedRecoveryCode && <div className="recovery-code"><strong>Save this code now</strong><code>{generatedRecoveryCode}</code><small>It is not stored by the app and cannot be shown again.</small></div>}</div>
    <div className="settings-card-wide"><div className="settings-card-title"><span className="setting-icon">↻</span><div><h3>Change master password</h3><p>Changing it disables both quick-unlock methods.</p></div></div><div className="form-row"><input type="password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} placeholder="Current password" /><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="New password" /><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Confirm new password" /><button onClick={submitPasswordChange}>Change password</button></div></div>
    <div className="settings-card-wide"><div className="settings-card-title"><span className="setting-icon">⇩</span><div><h3>Backup & recovery</h3><p>Create, inspect, restore, or schedule a portable encrypted vault backup.</p></div><div className="method-status"><span className={settings.backupPath ? "on" : ""}>{settings.backupPath ? `Every ${settings.backupIntervalDays} day${settings.backupIntervalDays === 1 ? "" : "s"}` : "Manual only"}</span></div></div><div className="button-row backup-controls"><button onClick={backup}>Create encrypted backup</button><button onClick={restore}>Inspect & restore backup</button><button onClick={configureAutomaticBackup}>Choose automatic backup</button><select value={settings.backupIntervalDays} onChange={(event) => setSettings({ ...settings, backupIntervalDays: Number(event.target.value) })}><option value={0}>Automatic backup off</option><option value={1}>Every day</option><option value={7}>Every 7 days</option><option value={30}>Every 30 days</option></select></div><small className="backup-note">{backupInfo ? `Last inspected backup: valid · ${backupInfo.note_count} notes · ${backupInfo.attachment_count} attachments` : settings.lastBackupAt ? `Last successful backup: ${fullDate(settings.lastBackupAt)}` : "No backup has been created in this installation yet."}</small></div>
    <div className="settings-card-wide security-summary"><div className="settings-card-title"><span className="setting-icon success">⬡</span><div><h3>Security dashboard</h3><p>Live diagnostics for this running build and encrypted vault.</p></div><button className="diagnostic-button" onClick={refreshDiagnostics}>Run checks</button></div><div className="security-grid"><span><b>{diagnostics?.database_integrity === false ? "!" : "✓"}</b> SQLCipher integrity</span><span><b>✓</b> PIN attempt throttling</span><span><b>✓</b> Lock after system resume</span><span><b>{diagnostics?.signed_build ? "✓" : "!"}</b> {diagnostics?.signed_build ? "Signed macOS build" : "Development/unsigned build"}</span><span><b>{diagnostics?.recovery_enabled ? "✓" : "!"}</b> Recovery key</span><span><b>✓</b> Authenticated backups</span></div>{diagnostics && <small className="backup-note">Protected content: {diagnostics.note_count} notes and {diagnostics.attachment_count} attachments. PIN {diagnostics.pin_enabled ? "enabled" : "off"}; Touch ID {diagnostics.biometric_enabled ? "enabled" : "off"}.</small>}</div>
    {error && <div className="error toast">{error}</div>}
  </section>;

  return <main className={`workspace-bg workspace-enter ${obscured ? "is-obscured" : ""}`}>
    {obscured && <div className="privacy-screen"><LockGlyph /><strong>Vault hidden</strong><small>Return to Secure Note Vault to reveal your notes.</small></div>}
    <section className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="mark"><LockGlyph /></span><div><strong>Secure Note Vault</strong><small>Your thoughts. Your control.</small></div></div>
        <button className="new" onClick={createNote}><span>＋</span> New note<b>⌄</b></button>
        <button className="new credential-new" onClick={createCredential}><span>◇</span> New credential<b>Secure</b></button>
        {nav}
        <ViewSwitcher value={workspaceView} onChange={(next) => { setScreen("notes"); setWorkspaceView(next); }} />
        {folders.length > 0 && <div className={`side-section ${foldersOpen ? "open" : "collapsed"}`}><button className="side-label" onClick={() => setFoldersOpen(!foldersOpen)} aria-expanded={foldersOpen}><span>Folders</span><b>{foldersOpen ? "⌄" : "›"}</b></button>{foldersOpen && folders.map((folder, index) => <button key={folder} onClick={() => { setScreen("notes"); setView("all"); setQuery(`folder:${folder}`); }}><i className={`folder-color color-${index % 4}`} />{folder}<b>{activeNotes.filter((note) => note.folder === folder).length}</b></button>)}</div>}
        {tags.length > 0 && <div className={`side-section tags ${tagsOpen ? "open" : "collapsed"}`}><button className="side-label" onClick={() => setTagsOpen(!tagsOpen)} aria-expanded={tagsOpen}><span>Tags</span><b>{tagsOpen ? "⌄" : "›"}</b></button>{tagsOpen && tags.map((tag, index) => <button key={tag} onClick={() => { setScreen("notes"); setView("all"); setQuery(`tag:${tag}`); }}><i className={`tag-dot color-${index % 4}`} />{tag}<b>{activeNotes.filter((note) => note.tags.includes(tag)).length}</b></button>)}</div>}
        {savedSearches.length > 0 && <div className="side-section saved-searches"><div className="side-label"><span>Saved searches</span><b>⌕</b></div>{savedSearches.map((search) => <div key={search.id}><button onClick={() => { setScreen("notes"); setView("all"); setQuery(search.query); }}><i>⌕</i>{search.name}</button><button title="Delete saved search" onClick={() => removeSavedSearch(search)}>×</button></div>)}</div>}
        <div className="side-actions"><button className="intelligence-side" onClick={() => setIntelligenceOpen(true)}><span>✦</span><div>Private Intelligence<small>Local ranker · Ready</small></div><i title="Available" /></button><button className={screen === "settings" ? "side-active" : ""} onClick={() => setScreen("settings")}><span>⚙</span>Settings & security</button></div>
        <div className="aside-footer"><div className="vault-state"><span><LockGlyph /></span><div><strong>Vault unlocked</strong><small>Encrypted & secure</small></div></div><button className="lock" onClick={doLock}><LockGlyph />Lock now</button></div>
      </aside>
      {screen === "settings" ? settingsPanel : screen === "dashboard" ? <ActionCenter notes={notes} activity={activityLog} onOpen={openCollectionNote} onComplete={(task) => void completeActionTask(task)} onQuickTask={(text, due, priority) => void createQuickTask(text, due, priority)} onDaily={openDailyNote} /> : workspaceView !== "list" ? <CollectionView view={workspaceView} notes={visible} onOpen={openCollectionNote} onMove={moveKanbanNote} /> : <>
        <section className="list">
          <div className="list-tools"><label><span>⌕</span><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by words or meaning…" /></label><button className="smart-search-button" title="Ask Your Vault" onClick={() => setIntelligenceOpen(true)}>✦</button><button title="Save this search" onClick={storeSearch}>☆</button><select aria-label="Sort notes" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}><option value="updated">Recent</option><option value="created">Created</option><option value="title">A–Z</option></select></div>
          <div className="list-head"><div><span className="eyebrow">YOUR SPACE</span><h2>{viewTitle}</h2></div><small>{visible.length} {visible.length === 1 ? "note" : "notes"}</small></div>
          <div className="notes">{visible.map((note) => <button className={`note ${note.id === selected ? "selected" : ""}`} key={note.id} onClick={() => setSelected(note.id)}><span className="note-icon">{isCredential(note) ? "◇" : "▤"}</span><span className="note-copy"><strong>{note.title || "Untitled note"}</strong><span>{isCredential(note) ? "Protected credential · fields hidden" : note.content.slice(0, 92) || "Empty note — open it and start writing."}</span><span className="note-bottom">{note.tags.slice(0, 2).map((tag) => <i key={tag}>#{tag}</i>)}<time>{shortDate(note.updated_at)}</time></span></span>{note.pinned && <b className="pin-star">★</b>}</button>)}{!visible.length && <div className="empty list-empty"><span>◇</span><strong>Nothing here yet</strong><small>Create a note or try another search.</small></div>}</div>
        </section>
        <section className="editor">
          {current ? <div className={`editor-layout ${infoPanelOpen ? "" : "info-collapsed"}`}>
            <article className="writing-pane">
              <header><div className="document-type"><span>▤</span><small>{current.folder || "Private note"}</small><i className={`save-state ${saveState}`}>{saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved" : saveState === "failed" ? "Save failed" : "Saved"}</i></div><div className="editor-actions"><button title="Attach encrypted file" onClick={attachFile}>⌕+</button><button title="Pin note" className={current.pinned ? "is-active" : ""} onClick={() => updateNote({ pinned: !current.pinned })}>☆</button><button className={`save-button ${saveState}`} onClick={save} disabled={saveState === "saved" || saveState === "saving"}>{saveState === "saving" ? "Saving…" : saveState === "failed" ? "Retry save" : saveState === "unsaved" ? "Save now" : "Saved"}</button><button className="panel-toggle" title="Toggle note information (Command + backslash)" onClick={() => setInfoPanelOpen(!infoPanelOpen)}>{infoPanelOpen ? "⇥" : "⇤"}</button><button className="lock-button" onClick={doLock}><LockGlyph />Lock</button></div></header>
              {isCredential(current) ? <div className="credential-editor"><div className="credential-heading"><span>◇</span><div><input className="title" value={current.title} onChange={(event) => updateNote({ title: event.target.value })} placeholder="Credential name" /><p>Protected fields stay masked and never appear in previews or Private Intelligence.</p></div></div><div className="credential-fields"><label><span>Username or email</span><div><input value={credentialData(current).username} onChange={(event) => updateCredential("username", event.target.value)} placeholder="name@example.com" /><button onClick={() => copyProtected(credentialData(current).username, "Username")}>Copy</button></div></label><label><span>Password</span><div><input type={revealedSecrets.has("password") ? "text" : "password"} value={credentialData(current).password} onChange={(event) => updateCredential("password", event.target.value)} placeholder="Password" /><button onClick={() => toggleSecret("password")}>{revealedSecrets.has("password") ? "Hide" : "Reveal"}</button><button onClick={() => copyProtected(credentialData(current).password, "Password")}>Copy</button></div></label><button className="generate-password" onClick={() => updateCredential("password", randomPassword())}>✦ Generate strong password</button><label><span>API key or token</span><div><input type={revealedSecrets.has("apiKey") ? "text" : "password"} value={credentialData(current).apiKey} onChange={(event) => updateCredential("apiKey", event.target.value)} placeholder="Optional protected token" /><button onClick={() => toggleSecret("apiKey")}>{revealedSecrets.has("apiKey") ? "Hide" : "Reveal"}</button><button onClick={() => copyProtected(credentialData(current).apiKey, "API key")}>Copy</button></div></label><label><span>Website or server URL</span><div><input value={credentialData(current).url} onChange={(event) => updateCredential("url", event.target.value)} placeholder="https://example.com" /><button onClick={() => copyProtected(credentialData(current).url, "URL")}>Copy</button></div></label><label><span>Private notes</span><textarea value={credentialData(current).notes} onChange={(event) => updateCredential("notes", event.target.value)} placeholder="Recovery details, server information, or related context…" /></label></div><footer><span>Organizational credential card</span><span>Secrets remask after 20 seconds</span><span>Clipboard clears after 30 seconds</span></footer></div> : <><div className="document-head"><input className="title" value={current.title} onChange={(event) => updateNote({ title: event.target.value })} placeholder="Untitled note" /><div className="document-meta"><span>▣ {current.folder || "No folder"}</span><span>◷ Edited {shortDate(current.updated_at)}</span><span><LockGlyph />Encrypted locally</span></div></div><div className="format-toolbar" aria-label="Markdown formatting"><button onClick={() => updateNote({ content: `${current.content}\n# Heading` })}>Heading 1⌄</button><button onClick={() => updateNote({ content: `${current.content}**bold**` })}><b>B</b></button><button onClick={() => updateNote({ content: `${current.content}_italic_` })}><i>I</i></button><button onClick={() => updateNote({ content: `${current.content}\n- ` })}>☷</button><button onClick={() => updateNote({ content: `${current.content}\n- [ ] ` })}>☑</button><button className="intelligence-toolbar-button" title="Open Private Intelligence" onClick={() => setIntelligenceOpen(true)}>✦ Intelligence</button><div className="mode-switch"><button className={editorMode === "write" ? "active" : ""} onClick={() => setEditorMode("write")}>Write</button><button className={editorMode === "preview" ? "active" : ""} onClick={() => setEditorMode("preview")}>Preview</button></div></div>{editorMode === "write" ? <textarea value={current.content} onChange={(event) => updateNote({ content: event.target.value })} placeholder="Start writing in Markdown…" /> : <MarkdownPreview source={current.content} onOpenLink={openInternalLink} />}<footer><span>Markdown supported</span><span>{wordCount(current.content)} words</span><span>Autosaves after you pause typing</span></footer></>}
            </article>
            {infoPanelOpen && <aside className="note-info">
              <div className="info-visual"><span><LockGlyph /></span><strong>Private & encrypted</strong><small>Stored only on this Mac</small></div>
              <InfoSection title="Note information"><dl><div><dt>Created</dt><dd>{fullDate(current.created_at)}</dd></div><div><dt>Last edited</dt><dd>{fullDate(current.updated_at)}</dd></div><div><dt>Word count</dt><dd>{wordCount(current.content)} words</dd></div><div><dt>Size</dt><dd>{new Blob([current.content]).size} bytes</dd></div></dl></InfoSection>
              <InfoSection title="Folder"><input value={current.folder ?? ""} onChange={(event) => updateNote({ folder: event.target.value || undefined })} placeholder="Optional folder" /></InfoSection>
              <InfoSection title="Tags" badge={current.tags.length}><input value={current.tags.join(", ")} onChange={(event) => updateNote({ tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} placeholder="work, important" /><div className="info-tags">{current.tags.map((tag) => <span key={tag}>#{tag}</span>)}{smartTags.map((tag) => <button key={tag} title="Add suggested tag" onClick={() => updateNote({ tags: [...current.tags, tag] })}>＋#{tag}</button>)}</div></InfoSection>
              <InfoSection title="Private summary" badge="✦ Local"><div className="smart-summary"><p>{smartSummary}</p></div></InfoSection>
              <InfoSection title="Related notes" badge={related.length}><div className="related-notes">{related.map((item) => <button key={item.note.id} onClick={() => setSelected(item.note.id)}><strong>{item.note.title || "Untitled note"}</strong><small>{item.excerpt}</small></button>)}{!related.length && <small>Connections appear as your vault grows.</small>}</div></InfoSection>
              <InfoSection title="Attachments" badge={attachments.length}><div className="attachments">{attachments.map((attachment) => <div key={attachment.id}><span>▧</span><button title="Preview attachment" onClick={() => showAttachment(attachment)}><strong>{attachment.name}</strong><small>{Math.max(1, Math.round(attachment.size / 1024))} KB · Preview</small></button>{attachment.mime.startsWith("image/") && <button className="ocr-file" title="Extract text privately with Apple Vision" disabled={ocrBusyId === attachment.id} onClick={() => scanAttachment(attachment)}>{ocrBusyId === attachment.id ? "…" : "Aa"}</button>}<button title="Export attachment" onClick={() => saveAttachmentFile(attachment)}>⇧</button><button className="remove-file" title="Remove attachment" onClick={() => deleteAttachmentFile(attachment)}>×</button></div>)}{!attachments.length && <small>No encrypted files attached.</small>}</div></InfoSection>
              <InfoSection title="Version history" badge={versions.length} defaultOpen={false}><div className="version-list">{versions.map((version) => <button key={version.id} onClick={() => restoreVersion(version)}><strong>{version.title || "Untitled note"}</strong><small>{fullDate(version.saved_at)} · Restore</small></button>)}{!versions.length && <small>Earlier autosaves will appear here.</small>}</div></InfoSection>
              <section className="note-controls"><label><span>☆ Pin note</span><input type="checkbox" checked={current.pinned} onChange={(event) => updateNote({ pinned: event.target.checked })} /></label><label><span>▱ Archive note</span><input type="checkbox" checked={current.archived} onChange={(event) => updateNote({ archived: event.target.checked })} /></label><button onClick={exportMarkdown}>⇧ Export Markdown</button><button onClick={shareEncrypted}>◇ Share encrypted</button>{current.deleted_at ? <><button onClick={async () => { await restoreNote(current.id); updateNote({ deleted_at: undefined }); }}>↻ Restore note</button><button className="danger" onClick={async () => { await permanentDeleteNote(current.id); const next = notes.filter((note) => note.id !== current.id); setNotes(next); setSelected(next[0]?.id); }}>♲ Delete forever</button></> : <button className="danger" onClick={async () => { await deleteNote(current.id); updateNote({ deleted_at: new Date().toISOString() }); }}>♲ Move to trash</button>}</section>
            </aside>}
          </div> : <div className="empty editor-empty"><span className="empty-icon"><LockGlyph /></span><strong>Your private writing space is ready</strong><small>Select a note from the list or create something new.</small><button onClick={createNote}>＋ Create a note</button></div>}
        </section>
      </>}
    </section>
    {commandOpen && <div className="command-backdrop" onMouseDown={() => setCommandOpen(false)}><section className="command-palette" onMouseDown={(event) => event.stopPropagation()}><header><span>⌘</span><div><strong>Command palette</strong><small>Search actions, then use ↑ ↓ and Enter</small></div><kbd>⌘ K</kbd></header><div className="command-search"><span>⌕</span><input autoFocus value={commandQuery} onChange={(event) => { setCommandQuery(event.target.value); setCommandIndex(0); }} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setCommandIndex((index) => Math.min(index + 1, commandActions.length - 1)); } else if (event.key === "ArrowUp") { event.preventDefault(); setCommandIndex((index) => Math.max(index - 1, 0)); } else if (event.key === "Enter") { event.preventDefault(); runCommand(commandIndex); } }} placeholder="Search commands…" /></div><div className="command-list">{commandActions.map((action, index) => <button key={action.label} className={`${index === commandIndex ? "active " : ""}${action.danger ? "command-lock" : ""}`} onMouseEnter={() => setCommandIndex(index)} onClick={() => runCommand(index)}><span>{action.icon}</span><b>{action.label}</b>{action.hint && <kbd>{action.hint}</kbd>}</button>)}{!commandActions.length && <div className="command-empty">No matching commands.</div>}</div></section></div>}
    {intelligenceOpen && <div className="intelligence-backdrop" onMouseDown={() => setIntelligenceOpen(false)}><section className="intelligence-panel" onMouseDown={(event) => event.stopPropagation()}><header><span>✦</span><div><strong>Ask Your Vault</strong><small>Local extractive ranker · no model download required</small></div><button onClick={() => setIntelligenceOpen(false)}>×</button></header><div className="intelligence-status"><span><i /> Engine ready</span><span>Model: local semantic ranker</span><span>External connections: blocked</span><span>{intelligenceBusy ? "Processing" : "Idle"}</span></div><div className="intelligence-input"><textarea autoFocus value={intelligenceQuestion} onChange={(event) => setIntelligenceQuestion(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runVaultQuestion(); }} placeholder="Ask about projects, decisions, plans, or anything in your notes…" /><button onClick={runVaultQuestion} disabled={!intelligenceQuestion.trim() || intelligenceBusy}>{intelligenceBusy ? "Processing locally…" : "Search privately"} <span>{intelligenceBusy ? "◌" : "→"}</span></button></div>{vaultAnswer ? <div className="intelligence-answer"><div className="answer-label"><span>✦</span><strong>Answer from your notes</strong></div><p>{vaultAnswer.answer}</p><div className="answer-sources"><small>{vaultAnswer.sources.length ? "Sources in your vault" : "No matching sources"}</small>{vaultAnswer.sources.map((source) => <button key={source.note.id} onClick={() => { setSelected(source.note.id); setScreen("notes"); setIntelligenceOpen(false); }}><span>▤</span><div><strong>{source.note.title || "Untitled note"}</strong><small>{source.excerpt}</small></div><b>→</b></button>)}</div></div> : <div className="intelligence-empty"><span>◎</span><strong>Your notes stay private</strong><p>Search by meaning, discover related ideas, and get extractive answers without sending vault content to any server.</p><div><button onClick={() => setIntelligenceQuestion("What are my current priorities?")}>Current priorities</button><button onClick={() => setIntelligenceQuestion("What decisions have I recorded?")}>Recent decisions</button><button onClick={() => setIntelligenceQuestion("Find my security-related notes")}>Passwords & access</button></div></div>}<footer><span>⬢ Core inference makes no network requests</span><span>Evidence-based results</span><kbd>⌘ ↵ to search</kbd></footer></section></div>}
    {ocrResult && <div className="preview-backdrop" onMouseDown={() => setOcrResult(undefined)}><section className="ocr-preview" onMouseDown={(event) => event.stopPropagation()}><header><div><strong>Recognized text</strong><small>{ocrResult.name} · {ocrResult.lineCount} lines · Apple Vision on-device</small></div><button onClick={() => setOcrResult(undefined)}>×</button></header><pre>{ocrResult.text}</pre><footer><span>Nothing is uploaded. Add this text to make it searchable inside the encrypted vault.</span><div><button onClick={() => setOcrResult(undefined)}>Cancel</button><button className="ocr-add" onClick={addOcrToCurrentNote}>Add to note</button></div></footer></section></div>}
    {attachmentPreview && <div className="preview-backdrop" onMouseDown={() => setAttachmentPreview(undefined)}><section className="attachment-preview" onMouseDown={(event) => event.stopPropagation()}><header><div><strong>{attachmentPreview.name}</strong><small>{attachmentPreview.mime}</small></div><button onClick={() => setAttachmentPreview(undefined)}>×</button></header><div className="preview-content">{attachmentPreview.mime.startsWith("image/") ? <img src={`data:${attachmentPreview.mime};base64,${attachmentPreview.data_base64}`} alt={attachmentPreview.name} /> : attachmentPreview.mime.startsWith("text/") || attachmentPreview.mime === "application/json" ? <pre>{decodeURIComponent(escape(atob(attachmentPreview.data_base64)))}</pre> : attachmentPreview.mime === "application/pdf" ? <iframe title={attachmentPreview.name} src={`data:application/pdf;base64,${attachmentPreview.data_base64}`} /> : <div className="no-preview"><span>▧</span><strong>Preview unavailable</strong><small>Export this file to open it in its native application.</small></div>}</div></section></div>}
    {error && screen === "notes" && <div className="error toast">{error}</div>}
  </main>;
}
