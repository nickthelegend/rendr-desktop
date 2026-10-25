// The little markdown agents actually write in a chat panel: **bold**,
// *italic*, `code`, bullet and numbered lists, and paragraphs.
//
// Built as React nodes, never as an HTML string, so nothing a model writes
// can become markup. Anything fancier (tables, links, headings) is shown as
// the text it is, which reads fine in a narrow column.

import type { ReactNode } from "react";

const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;

export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let index = 0;
	for (const match of text.matchAll(INLINE)) {
		const start = match.index ?? 0;
		if (start > last) out.push(text.slice(last, start));
		const token = match[0];
		const key = `${keyPrefix}-${index++}`;
		if (token.startsWith("**") || token.startsWith("__"))
			out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
		else if (token.startsWith("`")) out.push(<code key={key}>{token.slice(1, -1)}</code>);
		else out.push(<em key={key}>{token.slice(1, -1)}</em>);
		last = start + token.length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

type Block = { kind: "p"; lines: string[] } | { kind: "ul" | "ol"; items: string[] };

export function parseBlocks(text: string): Block[] {
	const blocks: Block[] = [];
	for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
		const line = raw.trimEnd();
		const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
		const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
		const current = blocks[blocks.length - 1];
		if (bullet || numbered) {
			const kind = bullet ? "ul" : "ol";
			const item = (bullet ?? numbered)?.[1] ?? "";
			if (current && current.kind === kind) current.items.push(item);
			else blocks.push({ kind, items: [item] });
			continue;
		}
		if (!line.trim()) {
			// A blank line ends whatever block was open.
			if (current && !(current.kind === "p" && current.lines.length === 0))
				blocks.push({ kind: "p", lines: [] });
			continue;
		}
		if (current?.kind === "p") current.lines.push(line);
		else blocks.push({ kind: "p", lines: [line] });
	}
	return blocks.filter((block) =>
		block.kind === "p" ? block.lines.length > 0 : block.items.length > 0,
	);
}

export function MiniMarkdown({ text }: { text: string }) {
	const blocks = parseBlocks(text);
	return (
		<>
			{blocks.map((block, blockIndex) => {
				const key = `b${blockIndex}`;
				if (block.kind === "p") {
					return (
						<p key={key} className="pmr-md__p">
							{block.lines.flatMap((line, lineIndex) =>
								lineIndex === 0
									? renderInline(line, `${key}-${lineIndex}`)
									: [
											<br key={`${key}-br${lineIndex}`} />,
											...renderInline(line, `${key}-${lineIndex}`),
										],
							)}
						</p>
					);
				}
				const List = block.kind;
				return (
					<List key={key} className="pmr-md__list">
						{block.items.map((item, itemIndex) => (
							<li key={`${key}-${itemIndex}`}>
								{renderInline(item, `${key}-${itemIndex}`)}
							</li>
						))}
					</List>
				);
			})}
		</>
	);
}
