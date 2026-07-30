// The workflow canvas.
//
// Takes the place of the timeline when a workflow is open, because the two
// answer different questions: a timeline is "what happens at 4.2 seconds", a
// workflow is "what happens to any recording I point at this". Showing both at
// once would imply they compose, and they don't — a workflow produces the
// timeline.
//
// Everything here goes through the same reducers the MCP tools use, so a graph
// built by dragging and a graph built by an agent are the same graph.

import { useCallback, useRef, useState } from "react";

import { PanelHeader } from "../Panel";
import type { EditorApi } from "../state";
import {
	canRun,
	connect,
	connectionError,
	createNode,
	disconnect,
	moveNode,
	NODE_SPECS,
	type NodeKind,
	nodeLabel,
	nodeSpec,
	removeNode,
	runOrder,
	type WorkflowModel,
	workflowIssues,
} from "../workflow";

const NODE_W = 150;
const NODE_H = 54;

/** Where a wire leaves a node, and where it arrives. */
const outPort = (node: { x: number; y: number }) => ({
	x: node.x + NODE_W,
	y: node.y + NODE_H / 2,
});
const inPort = (node: { x: number; y: number }) => ({ x: node.x, y: node.y + NODE_H / 2 });

/**
 * A wire, drawn as a cubic with horizontal tangents.
 *
 * Straight lines cross each other illegibly once a graph has more than three
 * nodes; a curve that leaves and arrives horizontally reads as flow.
 */
function wirePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
	const reach = Math.max(40, Math.abs(to.x - from.x) * 0.5);
	return `M ${from.x} ${from.y} C ${from.x + reach} ${from.y}, ${to.x - reach} ${to.y}, ${to.x} ${to.y}`;
}

export function WorkflowPanel({ api }: { api: EditorApi }) {
	const { state, toast } = api;
	const workflow = state.workflows.find((entry) => entry.id === state.activeWorkflowId);
	const surface = useRef<HTMLDivElement>(null);
	const [selected, setSelected] = useState<string | null>(null);
	/** The node a wire is being dragged from, if any. */
	const [wiring, setWiring] = useState<string | null>(null);

	const change = useCallback(
		(next: (current: WorkflowModel) => WorkflowModel) => {
			if (workflow) api.updateWorkflow(workflow.id, next);
		},
		[api, workflow],
	);

	/** Drags a node. Positions are committed as the pointer moves. */
	const dragNode = useCallback(
		(event: React.PointerEvent, nodeId: string) => {
			const node = workflow?.nodes.find((entry) => entry.id === nodeId);
			const surfaceNode = surface.current;
			if (!node || !surfaceNode) return;
			event.preventDefault();
			event.stopPropagation();
			setSelected(nodeId);

			const rect = surfaceNode.getBoundingClientRect();
			const grabX = event.clientX - rect.left - node.x;
			const grabY = event.clientY - rect.top - node.y;

			const onMove = (move: PointerEvent) => {
				change((current) =>
					moveNode(
						current,
						nodeId,
						Math.max(0, move.clientX - rect.left - grabX),
						Math.max(0, move.clientY - rect.top - grabY),
					),
				);
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[change, workflow],
	);

	if (!workflow) {
		return (
			<>
				<PanelHeader title="Workflow" />
				<div className="pmr-empty">
					<span>No workflow open</span>
					<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
						File → New Workflow, or ask the agent for a clips workflow.
					</span>
				</div>
			</>
		);
	}

	const issues = workflowIssues(workflow);
	const order = runOrder(workflow);
	const issueFor = (nodeId: string) =>
		issues.filter((issue) => issue.nodeId === nodeId).map((issue) => issue.message);

	return (
		<>
			<PanelHeader title={`Workflow · ${workflow.name}`}>
				<span className="pmr-wf__state" data-ready={canRun(workflow) || undefined}>
					{canRun(workflow) ? "ready to run" : `${issues.length} to fix`}
				</span>
			</PanelHeader>

			<div className="pmr-wf">
				{/* The palette. Each entry carries its summary as a title, so what a
				    node does is readable before it is placed. */}
				<div className="pmr-wf__palette">
					{NODE_SPECS.map((spec) => (
						<button
							type="button"
							key={spec.kind}
							className="pmr-wf__add"
							title={spec.summary}
							onClick={() => {
								const count = workflow.nodes.length;
								change((current) => ({
									...current,
									nodes: [
										...current.nodes,
										createNode(
											spec.kind as NodeKind,
											40 + (count % 5) * 180,
											40 + Math.floor(count / 5) * 90,
										),
									],
								}));
							}}
						>
							+ {spec.label}
						</button>
					))}
				</div>

				{/* A bare div takes the pointer here because the canvas is a drawing
				    surface, not a control: every actionable thing on it — node, port,
				    wire, delete — is its own button and reachable by keyboard. */}
				<div
					className="pmr-wf__canvas"
					ref={surface}
					onPointerDown={() => {
						setSelected(null);
						setWiring(null);
					}}
				>
					<svg className="pmr-wf__wires" aria-hidden="true">
						<title>Connections</title>
						{workflow.edges.map((edge) => {
							const from = workflow.nodes.find((n) => n.id === edge.from);
							const to = workflow.nodes.find((n) => n.id === edge.to);
							if (!from || !to) return null;
							return (
								<path
									key={edge.id}
									className="pmr-wf__wire"
									d={wirePath(outPort(from), inPort(to))}
									onClick={() => {
										change((current) => disconnect(current, edge.id));
										toast("Disconnected");
									}}
								/>
							);
						})}
					</svg>

					{workflow.nodes.map((node) => {
						const problems = issueFor(node.id);
						const step = order?.findIndex((entry) => entry.id === node.id) ?? -1;
						return (
							<div
								key={node.id}
								className="pmr-wf__node"
								data-selected={selected === node.id || undefined}
								data-problem={problems.length > 0 || undefined}
								data-wiring={wiring === node.id || undefined}
								style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
								title={problems.join("\n") || nodeSpec(node.kind)?.summary}
								onPointerDown={(event) => dragNode(event, node.id)}
							>
								<span className="pmr-wf__step">{step >= 0 ? step + 1 : "—"}</span>
								<span className="pmr-wf__label">{nodeLabel(node)}</span>

								{nodeSpec(node.kind)?.inputs === 1 ? (
									<button
										type="button"
										className="pmr-wf__port pmr-wf__port--in"
										title={
											wiring ? "Connect here" : "Drag from an output to here"
										}
										aria-label={`Input of ${nodeLabel(node)}`}
										onPointerDown={(event) => event.stopPropagation()}
										onClick={() => {
											if (!wiring) return;
											// Refused with the reason, never dropped
											// silently — a wire that looks connected
											// and isn't is the worst outcome here.
											const problem = connectionError(
												workflow,
												wiring,
												node.id,
											);
											if (problem) {
												toast(problem, "error");
											} else {
												const source = wiring;
												change((current) =>
													connect(current, source, node.id),
												);
											}
											setWiring(null);
										}}
									/>
								) : null}

								{nodeSpec(node.kind)?.hasOutput ? (
									<button
										type="button"
										className="pmr-wf__port pmr-wf__port--out"
										title="Start a connection, then click an input"
										aria-label={`Output of ${nodeLabel(node)}`}
										onPointerDown={(event) => event.stopPropagation()}
										onClick={() =>
											setWiring(node.id === wiring ? null : node.id)
										}
									/>
								) : null}

								<button
									type="button"
									className="pmr-wf__kill"
									title="Remove this node"
									aria-label={`Remove ${nodeLabel(node)}`}
									onPointerDown={(event) => event.stopPropagation()}
									onClick={() =>
										change((current) => removeNode(current, node.id))
									}
								>
									×
								</button>
							</div>
						);
					})}
				</div>

				{/* What would stop a run, said before it runs rather than after a
				    half-finished one leaves the project in an unclear state. */}
				{issues.length > 0 ? (
					<div className="pmr-wf__issues">
						{issues.map((issue) => (
							<span key={issue.message} className="pmr-wf__issue">
								{issue.message}
							</span>
						))}
					</div>
				) : null}
			</div>
		</>
	);
}
