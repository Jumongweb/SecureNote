import { describe, expect, it } from "vitest";
import { markdownBlocks } from "./MarkdownPreview";

describe("Markdown preview parser", () => {
  it("groups fenced code without interpreting its content as markup", () => {
    const blocks = markdownBlocks("# Demo\n```ts\nconst secret = 'local';\n```\nDone");
    expect(blocks[1]).toEqual({ type: "code", language: "ts", lines: ["const secret = 'local';"] });
  });

  it("recognizes a Markdown table", () => {
    const blocks = markdownBlocks("Name | State\n--- | ---\nVault | Locked");
    expect(blocks[0]).toMatchObject({ type: "table", rows: [["Name", "State"], ["Vault", "Locked"]] });
  });
});
