import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Note, saveNote, vaultStatus } from "./api";

export default function QuickCapture() {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [state, setState] = useState<"checking" | "ready" | "locked" | "saving">("checking");
  const [error, setError] = useState("");

  useEffect(() => {
    vaultStatus().then((status) => setState(status === "unlocked" ? "ready" : "locked")).catch(() => setState("locked"));
    let dispose: UnlistenFn | undefined;
    listen("vault-locked", () => { setTitle(""); setContent(""); setState("locked"); }).then((value) => { dispose = value; });
    return () => dispose?.();
  }, []);

  async function save() {
    if (!title.trim() && !content.trim()) return;
    setState("saving"); setError("");
    const now = new Date().toISOString();
    const note: Note = { id: crypto.randomUUID(), title: title.trim() || "Quick capture", content, created_at: now, updated_at: now, tags: ["quick-capture"], pinned: false, archived: false };
    try { await saveNote(note); setTitle(""); setContent(""); await getCurrentWindow().close(); }
    catch (reason) { setState("ready"); setError(String(reason).replace(/^Error:\s*/, "")); }
  }

  if (state === "checking") return <main className="quick-capture"><div className="capture-status">Opening encrypted capture…</div></main>;
  if (state === "locked") return <main className="quick-capture"><section className="capture-locked"><span>◇</span><strong>Vault locked</strong><p>Unlock Secure Note Vault before using Quick Capture.</p><button onClick={() => getCurrentWindow().close()}>Close</button></section></main>;
  return <main className="quick-capture"><section className="capture-card"><header><div><span>✦</span><strong>Quick Capture</strong></div><small>Encrypted locally</small></header><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void save(); }} /><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="Capture a thought, task, link, or idea…" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void save(); }} />{error && <p className="capture-error">{error}</p>}<footer><span>⌘⇧N opens from anywhere</span><div><button onClick={() => getCurrentWindow().close()}>Cancel</button><button className="capture-save" disabled={state === "saving" || (!title.trim() && !content.trim())} onClick={save}>{state === "saving" ? "Saving…" : "Save securely"}</button></div></footer></section></main>;
}
