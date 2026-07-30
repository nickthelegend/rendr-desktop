// Workflows: the graph rules.
//
// A visual editor lives or dies on refusing bad connections *visibly*. A wire
// that appears to exist and does nothing, or a graph that half-runs, is worse
// than a refusal — so these tests are mostly about what the model won't allow.

import { describe, expect, it } from "vitest";

import {
	canRun,
	clipsWorkflow,
	connect,
	connectionError,
	createNode,
	createWorkflow,
	describeRun,
	disconnect,
	moveNode,
	NODE_SPECS,
	nodeLabel,
	parseWorkflows,
	removeNode,
	runOrder,
	setNodeParams,
	type WorkflowModel,
	workflowIssues,
} from "./workflow";

/** A source → export pair, the smallest runnable graph. */
function pair(): { workflow: WorkflowModel; sourceId: string; exportId: string } {
	let workflow = createWorkflow("Test");
	const source = createNode("source", 0, 0);
	const out = createNode("export", 200, 0);
	workflow = { ...workflow, nodes: [source, out] };
	workflow = connect(workflow, source.id, out.id);
	return { workflow, sourceId: source.id, exportId: out.id };
}

describe("the node catalog", () => {
	it("gives every node a label and a one-line summary", () => {
		for (const spec of NODE_SPECS) {
			expect(spec.label.length).toBeGreaterThan(0);
			expect(spec.summary.length).toBeGreaterThan(10);
		}
	});

	it("has exactly one node with no input and one with no output", () => {
		expect(NODE_SPECS.filter((s) => s.inputs === 0).map((s) => s.kind)).toEqual(["source"]);
		expect(NODE_SPECS.filter((s) => !s.hasOutput).map((s) => s.kind)).toEqual(["export"]);
	});
});

describe("connecting nodes", () => {
	it("connects a source to an export", () => {
		const { workflow } = pair();
		expect(workflow.edges).toHaveLength(1);
	});

	it("refuses a self-connection", () => {
		const { workflow, sourceId } = pair();
		expect(connectionError(workflow, sourceId, sourceId)).toContain("feed itself");
	});

	it("refuses anything after a terminal node", () => {
		const { workflow, exportId } = pair();
		const extra = createNode("grade", 400, 0);
		const withExtra = { ...workflow, nodes: [...workflow.nodes, extra] };
		expect(connectionError(withExtra, exportId, extra.id)).toContain("terminal");
	});

	it("refuses feeding a source", () => {
		const { workflow, sourceId } = pair();
		const grade = createNode("grade", 400, 0);
		const withGrade = { ...workflow, nodes: [...workflow.nodes, grade] };
		expect(connectionError(withGrade, grade.id, sourceId)).toContain("takes no input");
	});

	it("refuses a duplicate wire", () => {
		const { workflow, sourceId, exportId } = pair();
		expect(connectionError(workflow, sourceId, exportId)).toContain("already connected");
	});

	it("refuses a second input, because a graph is a pipeline", () => {
		// Two inputs would mean deciding how to merge two timelines, which is an
		// edit rather than a wiring choice.
		const { workflow, exportId } = pair();
		const other = createNode("source", 0, 200);
		const withOther = { ...workflow, nodes: [...workflow.nodes, other] };
		expect(connectionError(withOther, other.id, exportId)).toContain("already has an input");
	});

	it("refuses a cycle", () => {
		let workflow = createWorkflow("cyc");
		const a = createNode("auto-zoom", 0, 0);
		const b = createNode("grade", 200, 0);
		workflow = { ...workflow, nodes: [a, b] };
		workflow = connect(workflow, a.id, b.id);
		expect(connectionError(workflow, b.id, a.id)).toContain("loop");
	});

	it("does not add a refused wire", () => {
		const { workflow, sourceId, exportId } = pair();
		// connect() is a no-op when the connection is invalid, so a caller that
		// ignores the error can't corrupt the graph.
		expect(connect(workflow, sourceId, exportId).edges).toHaveLength(1);
	});
});

describe("editing the graph", () => {
	it("takes an edge's wires with it when a node is removed", () => {
		const { workflow, sourceId } = pair();
		const after = removeNode(workflow, sourceId);
		expect(after.nodes).toHaveLength(1);
		// An edge to a node that no longer exists would draw a line to nowhere.
		expect(after.edges).toHaveLength(0);
	});

	it("disconnects one wire without touching the nodes", () => {
		const { workflow } = pair();
		const after = disconnect(workflow, workflow.edges[0].id);
		expect(after.edges).toHaveLength(0);
		expect(after.nodes).toHaveLength(2);
	});

	it("rounds positions so a reopened graph looks the same", () => {
		const { workflow, sourceId } = pair();
		const after = moveNode(workflow, sourceId, 12.7, 40.2);
		const node = after.nodes.find((n) => n.id === sourceId);
		expect(node?.x).toBe(13);
		expect(node?.y).toBe(40);
	});

	it("merges params rather than replacing them", () => {
		let { workflow } = pair();
		const reframe = createNode("reframe", 100, 100);
		workflow = { ...workflow, nodes: [...workflow.nodes, reframe] };
		workflow = setNodeParams(workflow, reframe.id, { aspect: "9:16" });
		workflow = setNodeParams(workflow, reframe.id, { padding: 0.04 });
		const node = workflow.nodes.find((n) => n.id === reframe.id);
		expect(node?.params).toEqual({ aspect: "9:16", padding: 0.04 });
	});
});

describe("run order", () => {
	it("puts a source first and an export last", () => {
		const order = runOrder(clipsWorkflow());
		expect(order).not.toBeNull();
		expect(order?.[0].kind).toBe("source");
		expect(order?.[order.length - 1].kind).toBe("export");
	});

	it("returns null for a graph with a loop", () => {
		// connectionError prevents building one, but a file written by another
		// version of the app is not trusted.
		const workflow: WorkflowModel = {
			id: "w",
			name: "loop",
			nodes: [createNode("grade", 0, 0), createNode("auto-zoom", 100, 0)],
			edges: [],
		};
		const [a, b] = workflow.nodes;
		const looped = {
			...workflow,
			edges: [
				{ id: "e1", from: a.id, to: b.id },
				{ id: "e2", from: b.id, to: a.id },
			],
		};
		expect(runOrder(looped)).toBeNull();
	});
});

describe("what would stop a run", () => {
	it("says an empty workflow needs a source", () => {
		expect(workflowIssues(createWorkflow("empty"))[0].message).toContain("Source");
	});

	it("flags a node with no input", () => {
		let workflow = createWorkflow("w");
		const source = createNode("source", 0, 0);
		const grade = createNode("grade", 200, 0);
		const out = createNode("export", 400, 0);
		workflow = { ...workflow, nodes: [source, grade, out] };
		workflow = connect(workflow, source.id, out.id);
		const issues = workflowIssues(workflow);
		expect(issues.some((i) => i.nodeId === grade.id && i.message.includes("no input"))).toBe(
			true,
		);
	});

	it("flags work that would be discarded", () => {
		let workflow = createWorkflow("w");
		const source = createNode("source", 0, 0);
		const grade = createNode("grade", 200, 0);
		workflow = { ...workflow, nodes: [source, grade] };
		workflow = connect(workflow, source.id, grade.id);
		const issues = workflowIssues(workflow);
		expect(issues.some((i) => i.message.includes("feeds nothing"))).toBe(true);
	});

	it("flags a workflow that would produce no file", () => {
		let workflow = createWorkflow("w");
		const source = createNode("source", 0, 0);
		workflow = { ...workflow, nodes: [source] };
		expect(workflowIssues(workflow).some((i) => i.message.includes("no file"))).toBe(true);
	});

	it("considers the clipping preset runnable as offered", () => {
		// The default has to work, or it teaches the wrong thing on first open.
		expect(workflowIssues(clipsWorkflow())).toEqual([]);
		expect(canRun(clipsWorkflow())).toBe(true);
	});
});

describe("the clipping preset", () => {
	it("goes source → highlights → cut → reframe → zoom → subtitle → export", () => {
		const order = runOrder(clipsWorkflow());
		expect(order?.map((n) => n.kind)).toEqual([
			"source",
			"detect-highlights",
			"split-clips",
			"reframe",
			"auto-zoom",
			"subtitle",
			"export",
		]);
	});

	it("sets a vertical aspect, so the default is actually short-form", () => {
		const reframe = clipsWorkflow().nodes.find((n) => n.kind === "reframe");
		expect(reframe?.params.aspect).toBe("9:16");
	});

	it("describes a run in one readable line", () => {
		expect(describeRun(clipsWorkflow())).toContain("Source → Find highlights");
	});
});

describe("loading a stored workflow", () => {
	it("drops nodes of an unknown kind and edges that dangle", () => {
		const parsed = parseWorkflows([
			{
				id: "w1",
				name: "Saved",
				nodes: [
					{ id: "a", kind: "source", x: 0, y: 0, params: {} },
					{ id: "b", kind: "from-the-future", x: 1, y: 1, params: {} },
				],
				edges: [
					{ id: "e1", from: "a", to: "b" },
					{ id: "e2", from: "a", to: "ghost" },
				],
			},
		]);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].nodes.map((n) => n.id)).toEqual(["a"]);
		// Both edges pointed at nodes that didn't survive.
		expect(parsed[0].edges).toEqual([]);
	});

	it("repairs missing coordinates rather than rendering NaN", () => {
		const parsed = parseWorkflows([
			{ id: "w", name: "n", nodes: [{ id: "a", kind: "source", params: {} }], edges: [] },
		]);
		expect(parsed[0].nodes[0].x).toBe(0);
		expect(parsed[0].nodes[0].y).toBe(0);
	});

	it("ignores anything that isn't a workflow", () => {
		expect(parseWorkflows(["nope", null, 7, {}])).toEqual([]);
		expect(parseWorkflows("not an array")).toEqual([]);
	});
});

describe("labels", () => {
	it("falls back to the kind's label", () => {
		expect(nodeLabel(createNode("auto-zoom", 0, 0))).toBe("Auto zoom");
	});

	it("prefers a name the user gave it", () => {
		expect(nodeLabel({ ...createNode("grade", 0, 0), label: "Warm look" })).toBe("Warm look");
	});
});

describe("ids", () => {
	it("does not collide across a restart", () => {
		// A bare counter resets when the renderer reloads, so a new workflow
		// would take an id a saved one already had — and a lookup by id then
		// returned somebody else's graph. This is the regression that produced
		// exactly that: a fresh preset resolved to a stale workflow.
		const ids = new Set<string>();
		for (let i = 0; i < 200; i++) ids.add(createWorkflow("w").id);
		expect(ids.size).toBe(200);
	});

	it("gives nodes and wires distinct ids too", () => {
		const nodeIds = new Set<string>();
		for (let i = 0; i < 200; i++) nodeIds.add(createNode("grade", 0, 0).id);
		expect(nodeIds.size).toBe(200);

		const preset = clipsWorkflow();
		expect(new Set(preset.nodes.map((n) => n.id)).size).toBe(preset.nodes.length);
		expect(new Set(preset.edges.map((e) => e.id)).size).toBe(preset.edges.length);
	});
});
