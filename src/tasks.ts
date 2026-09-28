import type { Note } from "./api";

export type TaskPriority = "high" | "normal" | "low";

export type VaultTask = {
  id: string;
  noteId: string;
  noteTitle: string;
  lineIndex: number;
  text: string;
  completed: boolean;
  priority: TaskPriority;
  dueAt?: number;
};

const CHECKBOX = /^(\s*[-*]\s+)\[([ xX])\](\s+)(.*)$/;
const DUE = /@due\((\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?\)/i;
const PRIORITY = /@priority\((high|normal|low)\)/i;

function localDue(date: string, hour?: string, minute?: string) {
  const parsed = new Date(`${date}T${hour ?? "09"}:${minute ?? "00"}:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.getTime();
}

export function extractTasks(notes: Note[]): VaultTask[] {
  return notes.flatMap((note) => {
    if (note.deleted_at || note.archived || note.tags.some((tag) => tag.toLowerCase() === "credential")) return [];
    return note.content.split("\n").flatMap((line, lineIndex) => {
      const checkbox = line.match(CHECKBOX);
      if (!checkbox) return [];
      const raw = checkbox[4];
      const due = raw.match(DUE);
      const priority = (raw.match(PRIORITY)?.[1]?.toLowerCase() as TaskPriority | undefined) ?? "normal";
      const dueAt = due ? localDue(due[1], due[2], due[3]) : undefined;
      const text = raw.replace(DUE, "").replace(PRIORITY, "").replace(/\s{2,}/g, " ").trim();
      return [{
        id: `${note.id}:${lineIndex}`,
        noteId: note.id,
        noteTitle: note.title || "Untitled note",
        lineIndex,
        text: text || "Untitled task",
        completed: checkbox[2].toLowerCase() === "x",
        priority,
        dueAt,
      }];
    });
  });
}

export function setTaskCompleted(content: string, lineIndex: number, completed = true) {
  const lines = content.split("\n");
  if (!lines[lineIndex]?.match(CHECKBOX)) return content;
  lines[lineIndex] = lines[lineIndex].replace(/^(\s*[-*]\s+)\[[ xX]\]/, `$1[${completed ? "x" : " "}]`);
  return lines.join("\n");
}

export function taskReminderRequests(tasks: VaultTask[]) {
  const now = Date.now();
  return tasks
    .filter((task) => !task.completed && task.dueAt && task.dueAt > now)
    .slice(0, 256)
    .map((task) => ({ id: `snv-${task.noteId}-${task.lineIndex}-${task.dueAt}`, dueAt: Math.floor(task.dueAt! / 1000) }));
}

export function taskLine(text: string, dueDate?: string, priority: TaskPriority = "normal") {
  const clean = text.replace(/[\r\n]+/g, " ").trim();
  const due = dueDate ? ` @due(${dueDate} 09:00)` : "";
  const importance = priority === "normal" ? "" : ` @priority(${priority})`;
  return `- [ ] ${clean}${due}${importance}`;
}
