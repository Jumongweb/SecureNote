import { useMemo, useState } from "react";
import type { Note } from "./api";
import { extractTasks, TaskPriority, VaultTask } from "./tasks";

type Props = {
  notes: Note[];
  activity: string[];
  onOpen: (note: Note) => void;
  onComplete: (task: VaultTask) => void;
  onQuickTask: (text: string, dueDate: string, priority: TaskPriority) => void;
  onDaily: () => void;
};

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const startOfDay = (value = new Date()) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
const parseTimestamp = (value: string) => new Date(/^\d+$/.test(value) ? Number(value) : value);

function relativeDue(value?: number) {
  if (!value) return "No due date";
  const days = Math.round((startOfDay(new Date(value)) - startOfDay()) / 86400000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(value);
}

export default function ActionCenter({ notes, activity, onOpen, onComplete, onQuickTask, onDaily }: Props) {
  const [taskText, setTaskText] = useState("");
  const [dueDate, setDueDate] = useState(dayKey(new Date()));
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const tasks = useMemo(() => extractTasks(notes), [notes]);
  const openTasks = tasks.filter((task) => !task.completed).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
  const today = startOfDay();
  const tomorrow = today + 86400000;
  const overdue = openTasks.filter((task) => task.dueAt && task.dueAt < today);
  const dueToday = openTasks.filter((task) => task.dueAt && task.dueAt >= today && task.dueAt < tomorrow);
  const upcoming = openTasks.filter((task) => !task.dueAt || task.dueAt >= tomorrow);
  const active = notes.filter((note) => !note.deleted_at && !note.archived && !note.tags.some((tag) => tag.toLowerCase() === "credential"));
  const spotlight = [...active].sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()).slice(0, 4);

  const activityCounts = useMemo(() => activity.reduce<Record<string, number>>((counts, stamp) => {
    const date = parseTimestamp(stamp);
    if (!Number.isNaN(date.getTime())) counts[dayKey(date)] = (counts[dayKey(date)] ?? 0) + 1;
    return counts;
  }, {}), [activity]);
  const heatDays = useMemo(() => Array.from({ length: 84 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (83 - index));
    return { key: dayKey(date), date, count: activityCounts[dayKey(date)] ?? 0 };
  }), [activityCounts]);
  const activeDays = heatDays.filter((day) => day.count > 0).length;

  const submit = () => {
    if (!taskText.trim()) return;
    onQuickTask(taskText, dueDate, priority);
    setTaskText("");
  };
  const section = (title: string, icon: string, items: VaultTask[], tone: string) => items.length > 0 && <section className={`action-task-group ${tone}`}>
    <header><span>{icon}</span><strong>{title}</strong><b>{items.length}</b></header>
    <div>{items.slice(0, 7).map((task) => <article key={task.id}>
      <button className="task-check" title="Mark complete" onClick={() => onComplete(task)}>✓</button>
      <button className="task-copy" onClick={() => { const note = notes.find((item) => item.id === task.noteId); if (note) onOpen(note); }}><strong>{task.text}</strong><small>{task.noteTitle} · {relativeDue(task.dueAt)}</small></button>
      {task.priority !== "normal" && <i className={`priority-${task.priority}`}>{task.priority}</i>}
    </article>)}</div>
  </section>;

  return <section className="action-center">
    <header className="action-heading"><div><span className="eyebrow">PRIVATE PRODUCTIVITY</span><h1>Action Center</h1><p>Your priorities, progress, and private reminders—drawn entirely from encrypted notes.</p></div><button onClick={onDaily}><span>☀</span> Open daily focus</button></header>
    <div className="action-metrics">
      <article><span>◎</span><div><strong>{dueToday.length}</strong><small>Due today</small></div></article>
      <article className={overdue.length ? "warning" : ""}><span>◷</span><div><strong>{overdue.length}</strong><small>Overdue</small></div></article>
      <article><span>✓</span><div><strong>{tasks.filter((task) => task.completed).length}</strong><small>Completed</small></div></article>
      <article><span>▦</span><div><strong>{activeDays}</strong><small>Active days · 12 weeks</small></div></article>
    </div>
    <div className="action-layout">
      <div className="action-main">
        <section className="quick-task"><div><span>＋</span><div><strong>Capture an action</strong><small>Saved in your encrypted Action Inbox</small></div></div><div className="quick-task-form"><input value={taskText} onChange={(event) => setTaskText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} placeholder="What needs to happen?" /><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /><select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select><button disabled={!taskText.trim()} onClick={submit}>Add task</button></div></section>
        <div className="action-tasks">{section("Overdue", "!", overdue, "overdue")}{section("Today", "☀", dueToday, "today")}{section("Upcoming & anytime", "→", upcoming, "upcoming")}{openTasks.length === 0 && <div className="action-empty"><span>✓</span><strong>You’re all clear</strong><small>Add a task here or write a Markdown checkbox in any note.</small></div>}</div>
      </div>
      <aside className="action-rail">
        <section className="activity-card"><header><div><strong>Vault activity</strong><small>{activeDays} writing days in the last 12 weeks</small></div><span>Local only</span></header><div className="activity-heatmap">{heatDays.map((day) => <i key={day.key} className={`level-${Math.min(4, day.count)}`} title={`${day.date.toLocaleDateString()}: ${day.count} activities`} />)}</div><footer><small>12 weeks ago</small><div><span>Less</span><i /><i className="level-1" /><i className="level-2" /><i className="level-4" /><span>More</span></div></footer></section>
        <section className="focus-card"><header><div><strong>Focus notes</strong><small>Pinned and recently active</small></div><span>✦</span></header>{spotlight.map((note) => <button key={note.id} onClick={() => onOpen(note)}><span>{note.pinned ? "★" : "▤"}</span><div><strong>{note.title || "Untitled note"}</strong><small>{note.folder || note.tags[0] || "Private note"}</small></div><b>→</b></button>)}{!spotlight.length && <p>Your recently edited notes will appear here.</p>}</section>
        <section className="reminder-card"><span>◉</span><div><strong>Private reminders active</strong><small>macOS receives only a generic alert and due time—never note or task text.</small></div></section>
      </aside>
    </div>
  </section>;
}
