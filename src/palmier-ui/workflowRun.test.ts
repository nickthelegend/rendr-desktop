// Running a workflow.
//
// The guarantee worth testing hardest: nothing is committed until every step
// succeeds. A workflow that half-runs leaves a project in a state nobody asked
// for, and the second-worst outcome is a step that silently passes the timeline
// through and lets the run report success having produced nothing.

import { describe, expect, it } from "vitest";

import type { CommentModel } from "./comments";
import { withDefaults } from "./model";
import type { TimelineModel } from "./reducers";
import { clipsWorkflow, connect, createNode, createWorkflow } from "./workflow";
import { type RunContext, runWorkflow } from "./workflowRun";

function take(): TimelineModel {
	return {
		id: "t",
		name: "Main",
		fps: 30,
		width: 1920,
		height: 1080,
		tracks: [
			{
				id: "v1",
				name: "V1",
				kind: "video",
				muted: false,
				hidden: false,
				clips: [
					withDefaults({
						id: "c1",
						name: "Screen recording",
						mediaType: "video",
						assetId: "a1",
						startFrame: 0,
						endFrame: 600,
					}),
				],
			},
		],
	};
}

/** Telemetry with three clear dwells, so highlights exist to cut at. */
function telemetry() {
	const points = [];
	const parks: Array<[number, number, number, number]> = [
		[1000, 2600, 0.25, 0.3],
		[6000, 7600, 0.7, 0.5],
		[12000, 13600, 0.45, 0.75],
	];
	for (let t = 0; t <= 20000; t += 80) {
		const park = parks.find(([from, to]) => t >= from && t <= to);
		points.push({
			timeMs: t,
			cx: park ? park[2] : 0.2 + 0.6 * Math.abs(Math.sin(t / 900)),
			cy: park ? park[3] : 0.3 + 0.4 * Math.abs(Math.cos(t / 1100)),
			interactionType: "move",
		});
	}
	return points;
}

const note = (frame: number, text: string): CommentModel => ({
	id: `n${frame}`,
	frame,
	text,
	durationFrames: 0,
	author: "user",
	createdAt: "2026-01-01T00:00:00Z",
});

function context(over: Partial<RunContext> = {}): RunContext {
	return {
		timeline: take(),
		assets: [],
		comments: [
			note(10, "This is the app I built."),
			note(300, "And here is the part that matters."),
		],
		telemetry: telemetry(),
		hooks: {
			narrate: async () => ({ spoken: 2, lines: [] }),
			export: async () => ({ path: "/tmp/out.mp4" }),
		},
		...over,
	};
}

describe("running the clips workflow", () => {
	it("runs every step and reports what each did", async () => {
		const report = await runWorkflow(clipsWorkflow(), context());
		expect(report.ok).toBe(true);
		expect(report.steps.map((s) => s.label)).toEqual([
			"Source",
			"Find highlights",
			"Cut to clips",
			"Reframe",
			"Auto zoom",
			"Subtitle",
			"Export",
		]);
		// Every step says something concrete, so a run log is readable.
		for (const step of report.steps) expect(step.detail.length).toBeGreaterThan(0);
	});

	it("actually cuts the take into more clips than it started with", async () => {
		const before = take().tracks.reduce((n, t) => n + t.clips.length, 0);
		const report = await runWorkflow(clipsWorkflow(), context());
		const after = (report.timeline?.tracks ?? []).reduce((n, t) => n + t.clips.length, 0);
		expect(after).toBeGreaterThan(before);
	});

	it("reframes to vertical, so the footage fills a 9:16 frame", async () => {
		const report = await runWorkflow(clipsWorkflow(), context());
		const clip = report.timeline?.tracks
			.flatMap((t) => t.clips)
			.find((c) => c.mediaType === "video");
		// 16:9 into 9:16 needs the footage more than three times the frame width.
		expect(clip?.transform.width).toBeGreaterThan(3);
		expect(clip?.transform.height).toBe(1);
	});

	it("puts captions on a CC track", async () => {
		const report = await runWorkflow(clipsWorkflow(), context());
		const cc = report.timeline?.tracks.find((t) => t.id === "trk-cc-narration");
		expect((cc?.clips ?? []).length).toBeGreaterThan(0);
	});

	it("reports where the file went", async () => {
		const report = await runWorkflow(clipsWorkflow(), context());
		expect(report.outputPath).toBe("/tmp/out.mp4");
	});
});

describe("stopping rather than half-running", () => {
	it("commits nothing when a later step fails", async () => {
		// Export is the last step; failing it must leave no timeline behind, or a
		// caller would apply four steps' worth of edits nobody asked for.
		const report = await runWorkflow(
			clipsWorkflow(),
			context({
				hooks: {
					narrate: async () => ({ spoken: 1, lines: [] }),
					export: async () => null,
				},
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.timeline).toBeUndefined();
		expect(report.error).toContain("Export");
	});

	it("names the node that stopped it", async () => {
		const report = await runWorkflow(clipsWorkflow(), context({ hooks: {} }));
		expect(report.ok).toBe(false);
		// Export has no hook, so that is where it stops.
		expect(report.error).toContain("Export");
	});

	it("refuses to run on an empty timeline instead of exporting nothing", async () => {
		const empty: TimelineModel = { ...take(), tracks: [] };
		const report = await runWorkflow(clipsWorkflow(), context({ timeline: empty }));
		expect(report.ok).toBe(false);
		expect(report.error).toContain("Nothing on the timeline");
	});

	it("says so when there is no cursor activity to cut to", async () => {
		const report = await runWorkflow(clipsWorkflow(), context({ telemetry: [] }));
		expect(report.ok).toBe(false);
		expect(report.error).toContain("Find highlights");
	});

	it("says so when there is no script to subtitle", async () => {
		let workflow = createWorkflow("subs");
		const source = createNode("source", 0, 0);
		const subtitle = createNode("subtitle", 200, 0);
		const out = createNode("export", 400, 0);
		workflow = { ...workflow, nodes: [source, subtitle, out] };
		workflow = connect(workflow, source.id, subtitle.id);
		workflow = connect(workflow, subtitle.id, out.id);

		const report = await runWorkflow(workflow, context({ comments: [] }));
		expect(report.ok).toBe(false);
		expect(report.error).toContain("No notes to subtitle");
	});

	it("refuses a graph with a loop", async () => {
		const source = createNode("source", 0, 0);
		const grade = createNode("grade", 100, 0);
		const looped = {
			...createWorkflow("loop"),
			nodes: [source, grade],
			edges: [
				{ id: "e1", from: source.id, to: grade.id },
				{ id: "e2", from: grade.id, to: source.id },
			],
		};
		const report = await runWorkflow(looped, context());
		expect(report.ok).toBe(false);
		expect(report.error).toContain("loop");
	});

	it("rejects an aspect it doesn't know, naming the ones it does", async () => {
		let workflow = createWorkflow("bad");
		const source = createNode("source", 0, 0);
		const reframe = { ...createNode("reframe", 200, 0), params: { aspect: "3:7" } };
		const out = createNode("export", 400, 0);
		workflow = { ...workflow, nodes: [source, reframe, out] };
		workflow = connect(workflow, source.id, reframe.id);
		workflow = connect(workflow, reframe.id, out.id);

		const report = await runWorkflow(workflow, context());
		expect(report.ok).toBe(false);
		expect(report.error).toContain("9:16");
	});
});

describe("disabled nodes", () => {
	it("skips them without failing the run", async () => {
		const workflow = clipsWorkflow();
		const withoutSubs = {
			...workflow,
			nodes: workflow.nodes.map((node) =>
				node.kind === "subtitle" ? { ...node, disabled: true } : node,
			),
		};
		const report = await runWorkflow(withoutSubs, context({ comments: [] }));
		// Subtitle would have failed on an empty script; disabled, it is skipped.
		expect(report.ok).toBe(true);
		expect(report.steps.map((s) => s.label)).not.toContain("Subtitle");
	});
});
