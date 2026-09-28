import { useMemo, useState } from "react";
import type { Note } from "./api";
import { relatedNotes } from "./intelligence";

export type WorkspaceView = "list" | "cards" | "kanban" | "calendar" | "graph";

const protectedNote = (note: Note) => note.tags.some((tag) => tag.toLowerCase() === "credential");
const preview = (note: Note) => protectedNote(note) ? "Protected credential · fields hidden" : note.content.replace(/[#*_>`-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || "Empty note";
const dateKey = (value: string) => new Date(/^\d+$/.test(value) ? Number(value) : value).toISOString().slice(0, 10);

export function ViewSwitcher({ value, onChange }: { value: WorkspaceView; onChange: (view: WorkspaceView) => void }) {
  return <div className="view-switcher" aria-label="Workspace view">
    {(["list", "cards", "kanban", "calendar", "graph"] as WorkspaceView[]).map((view) => <button key={view} className={value === view ? "active" : ""} onClick={() => onChange(view)} title={`${view[0].toUpperCase()}${view.slice(1)} view`}>{view === "list" ? "☷" : view === "cards" ? "▦" : view === "kanban" ? "▥" : view === "calendar" ? "▣" : "⌘"}<span>{view}</span></button>)}
  </div>;
}

function CardView({ notes, onOpen }: { notes: Note[]; onOpen: (note: Note) => void }) {
  return <div className="card-view">{notes.map((note) => <button key={note.id} onClick={() => onOpen(note)}><div className="card-icon">{protectedNote(note) ? "◇" : "▤"}</div><strong>{note.title || "Untitled note"}</strong><p>{preview(note)}</p><footer><span>{note.folder || "Private"}</span><time>{new Date(note.updated_at).toLocaleDateString()}</time></footer><div className="card-tags">{note.tags.slice(0, 3).map((tag) => <i key={tag}>#{tag}</i>)}</div></button>)}</div>;
}

const stages = [
  { id: "todo", title: "To do", accent: "#7589ab" },
  { id: "doing", title: "In progress", accent: "#5388ee" },
  { id: "done", title: "Completed", accent: "#48c495" },
] as const;

function noteStage(note: Note) {
  return stages.find((stage) => note.tags.some((tag) => tag.toLowerCase() === stage.id))?.id ?? "todo";
}

function KanbanView({ notes, onOpen, onMove }: { notes: Note[]; onOpen: (note: Note) => void; onMove: (note: Note, stage: string) => void }) {
  return <div className="kanban-view">{stages.map((stage) => <section key={stage.id} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const note = notes.find((item) => item.id === event.dataTransfer.getData("text/note-id")); if (note && noteStage(note) !== stage.id) onMove(note, stage.id); }}><header><span style={{ background: stage.accent }} /> <strong>{stage.title}</strong><b>{notes.filter((note) => noteStage(note) === stage.id).length}</b></header><div>{notes.filter((note) => noteStage(note) === stage.id).map((note) => <article key={note.id} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/note-id", note.id); }} onDragEnd={(event) => { event.dataTransfer.clearData("text/note-id"); }} onClick={() => onOpen(note)}><strong>{note.title || "Untitled note"}</strong><p>{preview(note)}</p><footer>{note.tags.filter((tag) => !stages.some((item) => item.id === tag)).slice(0, 2).map((tag) => <i key={tag}>#{tag}</i>)}<time>{new Date(note.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></footer><div className="kanban-move"><span>Move to</span>{stages.filter((target) => target.id !== stage.id).map((target) => <button key={target.id} type="button" title={`Move to ${target.title}`} onClick={(event) => { event.stopPropagation(); onMove(note, target.id); }}>{target.title}</button>)}</div></article>)}</div></section>)}</div>;
}

function CalendarView({ notes, onOpen }: { notes: Note[]; onOpen: (note: Note) => void }) {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: first.getDay() + count }, (_, index) => index < first.getDay() ? undefined : index - first.getDay() + 1);
  return <div className="calendar-view"><header><button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>←</button><strong>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong><button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>→</button></header><div className="calendar-week">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{cells.map((day, index) => { const key = day ? `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}` : ""; const dayNotes = notes.filter((note) => dateKey(note.created_at) === key); return <section key={index} className={!day ? "blank" : ""}>{day && <><b>{day}</b>{dayNotes.slice(0, 3).map((note) => <button key={note.id} onClick={() => onOpen(note)}>{protectedNote(note) ? "◇ " : ""}{note.title || "Untitled"}</button>)}{dayNotes.length > 3 && <small>+{dayNotes.length - 3} more</small>}</>}</section>; })}</div></div>;
}

function GraphView({ notes, onOpen }: { notes: Note[]; onOpen: (note: Note) => void }) {
  const [zoom, setZoom] = useState(1);
  const nodes = notes.slice(0, 36).map((note, index, all) => { const angle = (index / Math.max(all.length, 1)) * Math.PI * 2 - Math.PI / 2; const radius = 180 + (index % 3) * 42; return { note, x: 500 + Math.cos(angle) * radius, y: 315 + Math.sin(angle) * radius }; });
  const links = useMemo(() => nodes.flatMap((node) => relatedNotes(notes, node.note.id).slice(0, 2).map((related) => { const target = nodes.find((item) => item.note.id === related.note.id); return target && node.note.id < target.note.id ? { source: node, target, strength: Math.min(related.score, 1) } : undefined; }).filter(Boolean) as { source: typeof nodes[number]; target: typeof nodes[number]; strength: number }[]), [notes]);
  return <div className="graph-view"><div className="graph-tools"><div><strong>Knowledge graph</strong><small>Connections come from shared meaning, folders, and tags.</small></div><label>− <input type="range" min="70" max="150" value={zoom * 100} onChange={(event) => setZoom(Number(event.target.value) / 100)} /> ＋</label></div><svg viewBox="0 0 1000 630" role="img" aria-label="Interactive note knowledge graph"><g style={{ transform: `scale(${zoom})`, transformOrigin: "500px 315px" }}>{links.map((link, index) => <line key={index} x1={link.source.x} y1={link.source.y} x2={link.target.x} y2={link.target.y} opacity={0.18 + link.strength * 0.5} />)}{nodes.map(({ note, x, y }) => <g key={note.id} className={protectedNote(note) ? "credential-node" : ""} onClick={() => onOpen(note)} tabIndex={0} role="button"><circle cx={x} cy={y} r={note.pinned ? 27 : 22} /><text x={x} y={y + 4} textAnchor="middle">{protectedNote(note) ? "◇" : "▤"}</text><text className="node-title" x={x} y={y + 39} textAnchor="middle">{(note.title || "Untitled").slice(0, 18)}</text></g>)}</g></svg>{!nodes.length && <div className="graph-empty">Create notes to build your private knowledge graph.</div>}</div>;
}

export function CollectionView({ view, notes, onOpen, onMove }: { view: Exclude<WorkspaceView, "list">; notes: Note[]; onOpen: (note: Note) => void; onMove: (note: Note, stage: string) => void }) {
  return <section className="collection-view"><header><div><span>PRIVATE WORKSPACE</span><h1>{view === "graph" ? "Knowledge graph" : `${view[0].toUpperCase()}${view.slice(1)} view`}</h1><p>{notes.length} encrypted {notes.length === 1 ? "note" : "notes"} in this view</p></div></header>{view === "cards" ? <CardView notes={notes} onOpen={onOpen} /> : view === "kanban" ? <KanbanView notes={notes} onOpen={onOpen} onMove={onMove} /> : view === "calendar" ? <CalendarView notes={notes} onOpen={onOpen} /> : <GraphView notes={notes} onOpen={onOpen} />}</section>;
}
