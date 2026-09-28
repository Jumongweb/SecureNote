import { describe, expect, it } from "vitest";
import type { Note } from "./api";
import { extractTasks, setTaskCompleted, taskLine, taskReminderRequests } from "./tasks";

const note = (content: string, tags: string[] = []): Note => ({
  id: "note-1", title: "Plan", content, tags, created_at: "2026-09-27T00:00:00Z",
  updated_at: "2026-09-27T00:00:00Z", pinned: false, archived: false,
});

describe("vault tasks", () => {
  it("extracts due dates and priorities from markdown checklists", () => {
    const tasks = extractTasks([note("- [ ] Ship release @due(2099-10-03 14:30) @priority(high)\n- [x] Draft notes")]);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ text: "Ship release", priority: "high", completed: false, lineIndex: 0 });
    expect(new Date(tasks[0].dueAt!).getFullYear()).toBe(2099);
    expect(tasks[1].completed).toBe(true);
  });

  it("completes only the selected source line", () => {
    expect(setTaskCompleted("- [ ] First\n- [ ] Second", 1)).toBe("- [ ] First\n- [x] Second");
  });

  it("never exposes credentials as tasks or reminder content", () => {
    expect(extractTasks([note("- [ ] secret", ["credential"])] )).toEqual([]);
    const tasks = extractTasks([note(taskLine("Private meeting", "2099-10-03"))]);
    const reminders = taskReminderRequests(tasks);
    expect(JSON.stringify(reminders)).not.toContain("Private meeting");
  });
});
