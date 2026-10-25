// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MiniMarkdown, parseBlocks } from "./miniMarkdown";

describe("MiniMarkdown", () => {
	it("renders the emphasis agents write instead of showing asterisks", () => {
		const { container } = render(
			<MiniMarkdown text="**1 clip** on the timeline, *6 seconds* long, id `abc`." />,
		);
		expect(container.querySelector("strong")?.textContent).toBe("1 clip");
		expect(container.querySelector("em")?.textContent).toBe("6 seconds");
		expect(container.querySelector("code")?.textContent).toBe("abc");
		expect(container.textContent).not.toContain("**");
	});

	it("never turns model output into markup", () => {
		const { container } = render(
			<MiniMarkdown text={'<img src=x onerror="alert(1)"> **<b>hi</b>**'} />,
		);
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("b")).toBeNull();
		expect(container.textContent).toContain("<img");
	});

	it("groups bullets and numbered lines into lists, and blank lines into paragraphs", () => {
		const blocks = parseBlocks(
			"Done:\n- cut silences\n- added captions\n\n1. export\n2. upload\n\nNext para",
		);
		expect(blocks.map((block) => block.kind)).toEqual(["p", "ul", "ol", "p"]);
		const { container } = render(<MiniMarkdown text={"- a\n- b"} />);
		expect(container.querySelectorAll("li")).toHaveLength(2);
	});

	it("leaves a lone asterisk or a multiplication alone", () => {
		const { container } = render(<MiniMarkdown text="2 * 3 = 6 and 4*5" />);
		expect(container.textContent).toBe("2 * 3 = 6 and 4*5");
		expect(container.querySelector("em")).toBeNull();
	});
});
