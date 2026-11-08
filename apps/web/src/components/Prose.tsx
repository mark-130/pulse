import { Fragment, type ReactNode } from "react";

/**
 * A small, safe subset of markdown for AI text: **bold**, bullet lists ("- ", "* " or a bullet dot) and line breaks.
 * Everything else, including angle brackets, links and code, stays plain text. React escapes every string, nothing here
 * builds HTML, and no link is ever made live.
 */
const BOLD = /\*\*([^*\n]+?)\*\*/g;
const BULLET = /^\s*(?:[-*•])\s+(.*)$/;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(BOLD)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push(<strong key={i}>{m[1]}</strong>);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block = { kind: "p"; lines: string[] } | { kind: "ul"; items: string[] };

export function parseProse(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const bullet = BULLET.exec(raw);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      if (last?.kind === "ul") last.items.push(bullet[1] ?? "");
      else blocks.push({ kind: "ul", items: [bullet[1] ?? ""] });
    } else if (raw.trim() === "") {
      blocks.push({ kind: "p", lines: [] }); // a blank line ends the block
    } else if (last?.kind === "p" && last.lines.length > 0) last.lines.push(raw);
    else if (last?.kind === "p") last.lines.push(raw);
    else blocks.push({ kind: "p", lines: [raw] });
  }
  return blocks.filter((b) => (b.kind === "p" ? b.lines.length > 0 : true));
}

export function Prose({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`space-y-2 leading-[1.6] [overflow-wrap:anywhere] ${className}`}>
      {parseProse(text).map((b, i) =>
        b.kind === "ul" ? (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}
          </ul>
        ) : (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        ),
      )}
    </div>
  );
}
