// Workflows.
//
// A timeline is where you place things by hand. A workflow is where you say
// what should happen and it runs — the difference between editing one video and
// describing an edit that can be applied to any recording, repeatedly.
//
// The case that drives this: somebody finishes a hackathon build, records it
// once, and wants six vertical clips out of it for different platforms. Doing
// that on a timeline means six manual edits. Doing it as a workflow means one
// graph and six runs.
//
// A workflow is a directed graph of nodes. It is deliberately *not* a general
// dataflow language: every node takes a timeline-ish input and produces one, so
// a graph is always a pipeline over a project rather than a program that could
// mean anything. That constraint is what makes it possible to describe a
// workflow in a sentence and to say honestly what a node will do before it runs.

import type { TimelineModel } from "./reducers";

/** What a node does. Each maps onto work the editor can already perform. */
export type NodeKind =
	| "source"
	| "detect-highlights"
	| "split-clips"
	| "reframe"
	| "auto-zoom"
	| "narrate"
	| "subtitle"
	| "grade"
	| "export";

export interface WorkflowNode {
	id: string;
	kind: NodeKind;
	/** Shown on the node. Defaults to the kind's own label. */
	label?: string;
	/** Canvas position, so a graph looks the same when reopened. */
	x: number;
	y: number;
	/** Kind-specific settings. Validated by `nodeIssues`. */
	params: Record<string, unknown>;
	/** Turned off: kept in the graph, skipped on a run. */
	disabled?: boolean;
}

export interface WorkflowEdge {
	id: string;
	from: string;
	to: string;
}

export interface WorkflowModel {
	id: string;
	name: string;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
}

export interface NodeSpec {
	kind: NodeKind;
	label: string;
	/** One line, shown in the palette and in an agent's listing. */
	summary: string;
	/** How many inputs it accepts. A source takes none. */
	inputs: 0 | 1;
	/** False for a terminal node like export. */
	hasOutput: boolean;
}

/**
 * The node catalog.
 *
 * Every entry corresponds to something the editor can already do, because a
 * node that describes work nothing implements is worse than no node — it makes
 * a graph that looks like it will run and won't.
 */
export const NODE_SPECS: NodeSpec[] = [
	{
		kind: "source",
		label: "Source",
		summary: "A recording or an imported file. Where every workflow starts.",
		inputs: 0,
		hasOutput: true,
	},
	{
		kind: "detect-highlights",
		label: "Find highlights",
		summary:
			"Marks the moments worth keeping, from cursor activity and speech. What clipping decides its cuts from.",
		inputs: 1,
		hasOutput: true,
	},
	{
		kind: "split-clips",
		label: "Cut to clips",
		summary: "Splits the take into separate clips at the marked moments.",
		inputs: 1,
		hasOutput: true,
	},
	{
		kind: "reframe",
		label: "Reframe",
		summary: "Recomposes to another aspect — 9:16 for vertical, 1:1 for square.",
		inputs: 1,
		hasOutput: true,
	},
	{
		kind: "auto-zoom",
		label: "Auto zoom",
		summary: "Cuts punch-ins from the cursor, as a recording gets on import.",
		inputs: 1,
		hasOutput: true,
	},
	{
		kind: "narrate",
		label: "Narrate",
		summary: "Speaks the notes with the local voice and lays them on a track.",
		inputs: 1,
		hasOutput: true,
	},
	{
		kind: "subtitle",
		label: "Subtitle",
		summary: "Word-timed captions from the narration script.",
		inputs: 1,
		hasOutput: true,
	},
	{
		kind: "grade",
		label: "Grade",
		summary: "Applies a look — curves, balance, and the backdrop.",
		inputs: 1,
		hasOutput: true,
	},
	{
		kind: "export",
		label: "Export",
		summary: "Writes a file. Terminal — nothing follows it.",
		inputs: 1,
		hasOutput: false,
	},
];

const SPEC_BY_KIND = new Map(NODE_SPECS.map((spec) => [spec.kind, spec]));

export function nodeSpec(kind: NodeKind): NodeSpec | undefined {
	return SPEC_BY_KIND.get(kind);
}

export function nodeLabel(node: WorkflowNode): string {
	return node.label ?? nodeSpec(node.kind)?.label ?? node.kind;
}

let counter = 0;

export function createNode(kind: NodeKind, x: number, y: number): WorkflowNode {
	counter += 1;
	return { id: `n${counter.toString(36)}`, kind, x: Math.round(x), y: Math.round(y), params: {} };
}

export function createWorkflow(name: string): WorkflowModel {
	counter += 1;
	return {
		id: `wf${counter.toString(36)}`,
		name: name.trim() || "Untitled workflow",
		nodes: [],
		edges: [],
	};
}

/**
 * Whether an edge may be added.
 *
 * Refused rather than silently dropped, because a connection that appears to
 * exist and does nothing is the worst outcome in a visual editor.
 */
export function connectionError(workflow: WorkflowModel, from: string, to: string): string | null {
	if (from === to) return "A node can't feed itself.";
	const source = workflow.nodes.find((node) => node.id === from);
	const target = workflow.nodes.find((node) => node.id === to);
	if (!source || !target) return "One of those nodes isn't in this workflow.";

	if (!nodeSpec(source.kind)?.hasOutput) {
		return `${nodeLabel(source)} is terminal — nothing can follow it.`;
	}
	if (nodeSpec(target.kind)?.inputs === 0) {
		return `${nodeLabel(target)} takes no input.`;
	}
	if (workflow.edges.some((edge) => edge.from === from && edge.to === to)) {
		return "Those are already connected.";
	}
	// One input per node keeps a graph a pipeline: two inputs would mean
	// deciding how to merge two timelines, which is an edit, not a wiring choice.
	if (workflow.edges.some((edge) => edge.to === to)) {
		return `${nodeLabel(target)} already has an input. Disconnect it first.`;
	}
	if (reaches(workflow, to, from)) return "That would make a loop.";
	return null;
}

/** Whether `to` is reachable from `from`, following edges. */
function reaches(workflow: WorkflowModel, from: string, to: string): boolean {
	const seen = new Set<string>();
	const stack = [from];
	while (stack.length > 0) {
		const at = stack.pop() as string;
		if (at === to) return true;
		if (seen.has(at)) continue;
		seen.add(at);
		for (const edge of workflow.edges) {
			if (edge.from === at) stack.push(edge.to);
		}
	}
	return false;
}

export function connect(workflow: WorkflowModel, from: string, to: string): WorkflowModel {
	if (connectionError(workflow, from, to)) return workflow;
	counter += 1;
	return {
		...workflow,
		edges: [...workflow.edges, { id: `e${counter.toString(36)}`, from, to }],
	};
}

export function disconnect(workflow: WorkflowModel, edgeId: string): WorkflowModel {
	return { ...workflow, edges: workflow.edges.filter((edge) => edge.id !== edgeId) };
}

export function removeNode(workflow: WorkflowModel, nodeId: string): WorkflowModel {
	return {
		...workflow,
		nodes: workflow.nodes.filter((node) => node.id !== nodeId),
		// An edge to a node that no longer exists would render as a line to
		// nowhere, so they go with it.
		edges: workflow.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
	};
}

export function moveNode(
	workflow: WorkflowModel,
	nodeId: string,
	x: number,
	y: number,
): WorkflowModel {
	return {
		...workflow,
		nodes: workflow.nodes.map((node) =>
			node.id === nodeId ? { ...node, x: Math.round(x), y: Math.round(y) } : node,
		),
	};
}

export function setNodeParams(
	workflow: WorkflowModel,
	nodeId: string,
	params: Record<string, unknown>,
): WorkflowModel {
	return {
		...workflow,
		nodes: workflow.nodes.map((node) =>
			node.id === nodeId ? { ...node, params: { ...node.params, ...params } } : node,
		),
	};
}

/**
 * Run order: sources first, then each node once its input has run.
 *
 * Returns null when the graph can't be ordered — a cycle. `connectionError`
 * prevents cycles being created, but a workflow loaded from disk was written by
 * some other version of this app and is not trusted.
 */
export function runOrder(workflow: WorkflowModel): WorkflowNode[] | null {
	const incoming = new Map<string, number>();
	for (const node of workflow.nodes) incoming.set(node.id, 0);
	for (const edge of workflow.edges) {
		if (!incoming.has(edge.to) || !incoming.has(edge.from)) continue;
		incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
	}

	const ready = workflow.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0);
	const order: WorkflowNode[] = [];
	const queue = [...ready];
	while (queue.length > 0) {
		const node = queue.shift() as WorkflowNode;
		order.push(node);
		for (const edge of workflow.edges.filter((e) => e.from === node.id)) {
			const left = (incoming.get(edge.to) ?? 0) - 1;
			incoming.set(edge.to, left);
			if (left === 0) {
				const next = workflow.nodes.find((n) => n.id === edge.to);
				if (next) queue.push(next);
			}
		}
	}
	return order.length === workflow.nodes.length ? order : null;
}

export interface WorkflowIssue {
	nodeId?: string;
	message: string;
}

/**
 * What would stop this workflow running, said plainly before it runs.
 *
 * A workflow that half-runs and leaves a project in an unclear state is worse
 * than one that refuses, so everything checkable is checked up front.
 */
export function workflowIssues(workflow: WorkflowModel): WorkflowIssue[] {
	const issues: WorkflowIssue[] = [];
	if (workflow.nodes.length === 0) {
		return [{ message: "Empty workflow. Add a Source to begin." }];
	}
	if (runOrder(workflow) === null) {
		issues.push({ message: "The graph contains a loop, so it has no run order." });
	}
	if (!workflow.nodes.some((node) => node.kind === "source")) {
		issues.push({ message: "No Source, so there is nothing to work on." });
	}
	if (!workflow.nodes.some((node) => node.kind === "export")) {
		issues.push({ message: "No Export, so a run would produce no file." });
	}

	for (const node of workflow.nodes) {
		const spec = nodeSpec(node.kind);
		if (!spec) {
			issues.push({ nodeId: node.id, message: `Unknown node type '${node.kind}'.` });
			continue;
		}
		const hasInput = workflow.edges.some((edge) => edge.to === node.id);
		if (spec.inputs === 1 && !hasInput) {
			issues.push({ nodeId: node.id, message: `${nodeLabel(node)} has no input.` });
		}
		if (spec.hasOutput && node.kind !== "source") {
			const feeds = workflow.edges.some((edge) => edge.from === node.id);
			if (!feeds) {
				issues.push({
					nodeId: node.id,
					message: `${nodeLabel(node)} feeds nothing, so its work would be discarded.`,
				});
			}
		}
	}
	return issues;
}

/** A workflow with no issues is one that can be run. */
export function canRun(workflow: WorkflowModel): boolean {
	return workflowIssues(workflow).length === 0;
}

/**
 * The short-form clipping pipeline, ready to run.
 *
 * This is the workflow the feature exists for: take one long recording and get
 * vertical clips out of it. Offered as a starting point because an empty canvas
 * is a poor way to learn what the nodes do.
 */
export function clipsWorkflow(name = "Short-form clips"): WorkflowModel {
	const workflow = createWorkflow(name);
	const chain: NodeKind[] = [
		"source",
		"detect-highlights",
		"split-clips",
		"reframe",
		"auto-zoom",
		"subtitle",
		"export",
	];
	let out = workflow;
	let previous: WorkflowNode | null = null;
	chain.forEach((kind, index) => {
		const node = createNode(kind, 40 + index * 190, 120);
		out = { ...out, nodes: [...out.nodes, node] };
		if (previous) out = connect(out, previous.id, node.id);
		previous = node;
	});
	// The aspect that matters for short form, set so the default actually runs.
	const reframe = out.nodes.find((node) => node.kind === "reframe");
	if (reframe) out = setNodeParams(out, reframe.id, { aspect: "9:16" });
	return out;
}

/** Parses a stored workflow, dropping anything malformed rather than throwing. */
export function parseWorkflows(value: unknown): WorkflowModel[] {
	if (!Array.isArray(value)) return [];
	const out: WorkflowModel[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Partial<WorkflowModel>;
		if (typeof entry.id !== "string" || typeof entry.name !== "string") continue;
		const nodes = (Array.isArray(entry.nodes) ? entry.nodes : []).filter(
			(node): node is WorkflowNode =>
				Boolean(node) &&
				typeof node.id === "string" &&
				typeof node.kind === "string" &&
				SPEC_BY_KIND.has(node.kind as NodeKind),
		);
		const ids = new Set(nodes.map((node) => node.id));
		const edges = (Array.isArray(entry.edges) ? entry.edges : []).filter(
			(edge): edge is WorkflowEdge =>
				Boolean(edge) &&
				typeof edge.id === "string" &&
				ids.has(edge.from as string) &&
				ids.has(edge.to as string),
		);
		out.push({
			id: entry.id,
			name: entry.name,
			nodes: nodes.map((node) => ({
				...node,
				x: Number.isFinite(node.x) ? node.x : 0,
				y: Number.isFinite(node.y) ? node.y : 0,
				params: node.params && typeof node.params === "object" ? node.params : {},
			})),
			edges,
		});
	}
	return out;
}

/** A one-line description of what a run would do, for a receipt or a tooltip. */
export function describeRun(workflow: WorkflowModel, timeline?: TimelineModel): string {
	const order = runOrder(workflow);
	if (!order) return "This workflow has a loop and cannot run.";
	const steps = order
		.filter((node) => !node.disabled)
		.map((node) => nodeLabel(node))
		.join(" → ");
	const on = timeline ? ` on ${timeline.name}` : "";
	return steps.length > 0 ? `${steps}${on}` : "Nothing to run.";
}
