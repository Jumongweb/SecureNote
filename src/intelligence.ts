import type { Note } from "./api";

export type RankedNote = { note: Note; score: number; excerpt: string };
export type VaultAnswer = { answer: string; sources: RankedNote[] };

const stopWords = new Set("a an and are as at be been but by can could did do does for from had has have how i if in into is it its may more most my no not of on or our so than that the their them then there these they this to was we were what when where which who why will with would you your".split(" "));
const synonymGroups = [
  ["password", "credential", "login", "secret", "pin", "access", "authentication"],
  ["meeting", "discussion", "agenda", "decision", "minutes", "attendee"],
  ["project", "milestone", "roadmap", "task", "deadline", "deliverable"],
  ["money", "finance", "budget", "payment", "invoice", "expense", "bank"],
  ["travel", "trip", "flight", "hotel", "journey", "vacation"],
  ["idea", "brainstorm", "concept", "proposal", "thought"],
  ["server", "database", "deployment", "production", "hosting", "cloud"],
  ["personal", "journal", "diary", "reflection", "private"],
  ["work", "office", "business", "client", "professional"],
  ["important", "priority", "urgent", "critical", "essential"],
];
const isProtectedCredential = (note: Note) => note.tags.some((tag) => tag.toLowerCase() === "credential");

function stem(word: string) {
  return word.replace(/(?:ing|edly|edly|ed|ies|s)$/i, (suffix) => suffix === "ies" ? "y" : "");
}

export function tokens(value: string) {
  return (value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])
    .filter((word) => !stopWords.has(word))
    .map(stem)
    .filter((word) => word.length > 1 && !stopWords.has(word));
}

function expandedTokens(value: string) {
  const result = new Set(tokens(value));
  for (const token of [...result]) {
    const group = synonymGroups.find((items) => items.includes(token));
    group?.forEach((item) => result.add(item));
  }
  return result;
}

function noteText(note: Note) {
  return `${note.title} ${note.title} ${note.folder ?? ""} ${note.tags.join(" ")} ${isProtectedCredential(note) ? "" : note.content}`;
}

function frequencies(value: string) {
  const result = new Map<string, number>();
  for (const token of tokens(value)) result.set(token, (result.get(token) ?? 0) + 1);
  return result;
}

function sentences(value: string) {
  return value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*>\d.\s]+/gm, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 20);
}

function excerptFor(note: Note, query: Set<string>) {
  if (isProtectedCredential(note)) return "Protected credential · fields hidden";
  const lines = sentences(note.content);
  const best = lines.sort((left, right) => {
    const score = (line: string) => tokens(line).filter((token) => query.has(token)).length;
    return score(right) - score(left);
  })[0] ?? note.content.trim();
  return best.slice(0, 180) || "Empty note";
}

export function semanticSearch(notes: Note[], query: string): RankedNote[] {
  const queryTokens = expandedTokens(query);
  if (!queryTokens.size) return [];
  const phrase = query.trim().toLowerCase();
  return notes
    .filter((note) => !note.deleted_at)
    .map((note) => {
      const body = noteText(note).toLowerCase();
      const counts = frequencies(body);
      let score = body.includes(phrase) ? 12 : 0;
      for (const token of queryTokens) {
        const count = counts.get(stem(token)) ?? counts.get(token) ?? 0;
        if (count) score += 1 + Math.log2(count + 1);
        if (tokens(note.title).includes(stem(token))) score += 4;
        if (note.tags.some((tag) => tokens(tag).includes(stem(token)))) score += 3;
      }
      return { note, score, excerpt: excerptFor(note, queryTokens) };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
}

export function relatedNotes(notes: Note[], currentId: string): RankedNote[] {
  const current = notes.find((note) => note.id === currentId);
  if (!current) return [];
  const base = new Set(tokens(noteText(current)));
  return notes
    .filter((note) => note.id !== currentId && !note.deleted_at)
    .map((note) => {
      const candidate = new Set(tokens(noteText(note)));
      const shared = [...base].filter((token) => candidate.has(token)).length;
      const union = new Set([...base, ...candidate]).size || 1;
      const sharedTags = note.tags.filter((tag) => current.tags.includes(tag)).length;
      const folder = note.folder && note.folder === current.folder ? 1 : 0;
      const score = shared / union + sharedTags * 0.3 + folder * 0.2;
      return { note, score, excerpt: excerptFor(note, base) };
    })
    .filter((result) => result.score >= 0.08)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);
}

export function summarizeNote(note: Note) {
  if (isProtectedCredential(note)) return "Protected credential fields are intentionally excluded from summaries and previews.";
  const lines = sentences(note.content);
  if (!lines.length) return "Add more detail to generate a private summary.";
  const counts = frequencies(noteText(note));
  const ranked = lines.map((line, index) => ({
    line,
    index,
    score: tokens(line).reduce((total, token) => total + (counts.get(token) ?? 0), 0) / Math.max(tokens(line).length, 1),
  })).sort((left, right) => right.score - left.score).slice(0, 3).sort((left, right) => left.index - right.index);
  return ranked.map((item) => item.line).join(" ").slice(0, 520);
}

export function suggestTags(note: Note, allNotes: Note[]) {
  const known = new Set(allNotes.flatMap((item) => item.tags.map((tag) => tag.toLowerCase())));
  const counts = frequencies(`${note.title} ${note.title} ${note.content}`);
  const candidates = [...counts]
    .filter(([word]) => word.length >= 3 && !note.tags.some((tag) => tag.toLowerCase() === word))
    .map(([word, count]) => ({ word, score: count + (known.has(word) ? 4 : 0) }))
    .sort((left, right) => right.score - left.score || left.word.localeCompare(right.word));
  return candidates.slice(0, 5).map((item) => item.word);
}

export function askVault(notes: Note[], question: string): VaultAnswer {
  const sources = semanticSearch(notes, question).slice(0, 5);
  if (!sources.length) return { answer: "I couldn't find a relevant note in this vault. Try mentioning a project, person, tag, or specific detail.", sources: [] };
  const questionTokens = expandedTokens(question);
  const evidence = sources.filter((source) => !isProtectedCredential(source.note)).flatMap((source) => sentences(source.note.content).map((line) => ({
    line,
    title: source.note.title || "Untitled note",
    score: tokens(line).filter((token) => questionTokens.has(token)).length + source.score / 10,
  }))).sort((left, right) => right.score - left.score).slice(0, 3);
  const answer = evidence.length
    ? evidence.map((item) => `${item.line} — ${item.title}`).join("\n\n")
    : `The most relevant note is “${sources[0].note.title || "Untitled note"}”. ${sources[0].excerpt}`;
  return { answer, sources };
}
