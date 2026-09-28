import { describe, expect, it } from "vitest";
import type { Note } from "./api";
import { askVault, relatedNotes, semanticSearch, summarizeNote } from "./intelligence";

const note = (id: string, title: string, content: string, tags: string[] = []): Note => ({
  id, title, content, tags, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", pinned: false, archived: false,
});

describe("private intelligence", () => {
  const notes = [
    note("1", "Production setup", "The database server uses PostgreSQL and needs a deployment checklist.", ["work"]),
    note("2", "Release checklist", "Deploy the server after database migrations and health checks.", ["work"]),
    note("3", "Bank login", JSON.stringify({ username: "person", password: "never-leak-this" }), ["credential"]),
  ];

  it("ranks meaning-related notes and discovers connections", () => {
    expect(semanticSearch(notes, "server deployment")[0].note.id).toBe("1");
    expect(relatedNotes(notes, "1").map((item) => item.note.id)).toContain("2");
  });

  it("never exposes protected credential fields", () => {
    const result = semanticSearch(notes, "bank login")[0];
    expect(result.excerpt).toContain("fields hidden");
    expect(result.excerpt).not.toContain("never-leak-this");
    expect(summarizeNote(notes[2])).not.toContain("never-leak-this");
    expect(askVault(notes, "bank login").answer).not.toContain("never-leak-this");
  });
});
