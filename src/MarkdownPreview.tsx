import { Fragment, ReactNode } from "react";

export type MarkdownBlock =
  | { type: "code"; language: string; lines: string[] }
  | { type: "table"; rows: string[][] }
  | { type: "line"; value: string; index: number };

export function markdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.split("\n");
  const blocks: MarkdownBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      while (++index < lines.length && !lines[index].startsWith("```")) code.push(lines[index]);
      blocks.push({ type: "code", language, lines: code });
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      const rows = [line.split("|").map((cell) => cell.trim()).filter(Boolean)];
      index += 1;
      while (index + 1 < lines.length && lines[index + 1].includes("|")) {
        rows.push(lines[++index].split("|").map((cell) => cell.trim()).filter(Boolean));
      }
      blocks.push({ type: "table", rows });
      continue;
    }
    blocks.push({ type: "line", value: line, index });
  }
  return blocks;
}

function Inline({ value, onOpenLink }: { value: string; onOpenLink?: (title: string) => void }) {
  const pieces = value.split(/(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\))/g);
  return <>{pieces.map((part, index): ReactNode => {
    if (part.startsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("_") && part.endsWith("_")) return <em key={index}>{part.slice(1, -1)}</em>;
    if (part.startsWith("`") && part.endsWith("`")) return <code className="inline-code" key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("[[")) {
      const title = part.slice(2, -2);
      return <button className="internal-link" key={index} onClick={() => onOpenLink?.(title)}>⌁ {title}</button>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) return <span className="external-link" title={link[2]} key={index}>↗ {link[1]}</span>;
    return <Fragment key={index}>{part}</Fragment>;
  })}</>;
}

function HighlightedCode({ line }: { line: string }) {
  const tokens = line.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|fn|function|return|if|else|for|while|async|await|struct|enum|impl|pub|use|import|from|class|new|true|false|null|None|Some|Ok|Err)\b|\b\d+(?:\.\d+)?\b|\/\/.*$|#.*$)/g);
  return <>{tokens.map((token, index) => {
    const kind = /^['"]/.test(token) ? "string" : /^(\/\/|#)/.test(token) ? "comment" : /^\d/.test(token) ? "number" : /^(const|let|var|fn|function|return|if|else|for|while|async|await|struct|enum|impl|pub|use|import|from|class|new|true|false|null|None|Some|Ok|Err)$/.test(token) ? "keyword" : "";
    return kind ? <span className={`syntax-${kind}`} key={index}>{token}</span> : <Fragment key={index}>{token}</Fragment>;
  })}</>;
}

export default function MarkdownPreview({ source, onOpenLink }: { source: string; onOpenLink?: (title: string) => void }) {
  return <div className="markdown-preview">{markdownBlocks(source).map((block, blockIndex) => {
    if (block.type === "code") return <figure className="code-block" key={blockIndex}><figcaption><span>{block.language || "plain text"}</span><b>Local preview</b></figcaption><pre>{block.lines.map((line, index) => <code key={index}><span className="line-number">{index + 1}</span><HighlightedCode line={line} />{"\n"}</code>)}</pre></figure>;
    if (block.type === "table") return <div className="table-scroll" key={blockIndex}><table><thead><tr>{block.rows[0].map((cell, index) => <th key={index}><Inline value={cell} onOpenLink={onOpenLink} /></th>)}</tr></thead><tbody>{block.rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}><Inline value={cell} onOpenLink={onOpenLink} /></td>)}</tr>)}</tbody></table></div>;
    const line = block.value;
    if (line.startsWith("### ")) return <h3 key={blockIndex}><Inline value={line.slice(4)} onOpenLink={onOpenLink} /></h3>;
    if (line.startsWith("## ")) return <h2 key={blockIndex}><Inline value={line.slice(3)} onOpenLink={onOpenLink} /></h2>;
    if (line.startsWith("# ")) return <h1 key={blockIndex}><Inline value={line.slice(2)} onOpenLink={onOpenLink} /></h1>;
    if (/^- \[[ xX]\] /.test(line)) return <label className="preview-check" key={blockIndex}><input type="checkbox" readOnly checked={line.slice(3, 4).toLowerCase() === "x"} /><Inline value={line.slice(6)} onOpenLink={onOpenLink} /></label>;
    if (line.startsWith("- ")) return <div className="preview-list" key={blockIndex}>• <span><Inline value={line.slice(2)} onOpenLink={onOpenLink} /></span></div>;
    if (line.startsWith("> ")) return <blockquote key={blockIndex}><Inline value={line.slice(2)} onOpenLink={onOpenLink} /></blockquote>;
    if (/^---+$/.test(line.trim())) return <hr key={blockIndex} />;
    if (!line.trim()) return <br key={blockIndex} />;
    return <p key={blockIndex}><Inline value={line} onOpenLink={onOpenLink} /></p>;
  })}</div>;
}
