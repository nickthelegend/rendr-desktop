// Resizable split, modelled on Palmier Pro's PaddedDividerSplitViewController:
// dividers draw thin but take a fatter hit area, and each pane keeps a minimum
// thickness. Collapsed panes are removed from the flow entirely, matching
// NSSplitViewItem.isCollapsed.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

export interface SplitPane {
	key: string;
	content: ReactNode;
	/** Fraction of the split's main axis. Renormalized across visible panes. */
	size: number;
	minPx: number;
	maxPx?: number;
	collapsed?: boolean;
}

interface SplitProps {
	direction: "horizontal" | "vertical";
	panes: SplitPane[];
	/** Persisted per split, like NSSplitView's autosaveName. */
	onResize?: (sizes: Record<string, number>) => void;
}

export function Split({ direction, panes, onResize }: SplitProps) {
	const isHorizontal = direction === "horizontal";
	const containerRef = useRef<HTMLDivElement>(null);
	const [sizes, setSizes] = useState<Record<string, number>>(() =>
		Object.fromEntries(panes.map((pane) => [pane.key, pane.size])),
	);
	const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

	// Adopt sizes for panes that appear later (a collapsed pane reopening).
	useEffect(() => {
		setSizes((current) => {
			let changed = false;
			const next = { ...current };
			for (const pane of panes) {
				if (next[pane.key] === undefined) {
					next[pane.key] = pane.size;
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, [panes]);

	const visible = panes.filter((pane) => !pane.collapsed);

	const beginDrag = useCallback(
		(index: number, event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			const container = containerRef.current;
			if (!container) return;

			const before = visible[index];
			const after = visible[index + 1];
			if (!before || !after) return;

			const total = isHorizontal ? container.clientWidth : container.clientHeight;
			const startPos = isHorizontal ? event.clientX : event.clientY;
			const startBefore = sizes[before.key] ?? before.size;
			const startAfter = sizes[after.key] ?? after.size;
			// Fractions are relative to the visible set, so convert through the pair's own span.
			const pairFraction = startBefore + startAfter;
			const pairPx = total * pairFraction;

			setDraggingIndex(index);

			const onMove = (moveEvent: PointerEvent) => {
				const delta = (isHorizontal ? moveEvent.clientX : moveEvent.clientY) - startPos;
				let beforePx = startBefore * total + delta;
				const minBefore = before.minPx;
				const minAfter = after.minPx;
				const maxBefore = before.maxPx ?? pairPx - minAfter;

				beforePx = Math.max(
					minBefore,
					Math.min(beforePx, Math.min(maxBefore, pairPx - minAfter)),
				);
				const afterPx = pairPx - beforePx;

				setSizes((current) => ({
					...current,
					[before.key]: beforePx / total,
					[after.key]: afterPx / total,
				}));
			};

			const onUp = () => {
				setDraggingIndex(null);
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				setSizes((current) => {
					onResize?.(current);
					return current;
				});
			};

			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[isHorizontal, onResize, sizes, visible],
	);

	// Visible fractions rarely sum to 1 once panes collapse; renormalize so
	// flex-basis stays honest.
	const totalFraction =
		visible.reduce((sum, pane) => sum + (sizes[pane.key] ?? pane.size), 0) || 1;

	return (
		<div ref={containerRef} className={`pmr-split pmr-split--${isHorizontal ? "h" : "v"}`}>
			{visible
				.map((pane, index) => (
					<div
						key={pane.key}
						style={{
							flex: `${((sizes[pane.key] ?? pane.size) / totalFraction) * 100} 1 0%`,
							minWidth: isHorizontal ? pane.minPx : 0,
							minHeight: isHorizontal ? 0 : pane.minPx,
							display: "flex",
							flexDirection: "column",
							overflow: "hidden",
						}}
					>
						{pane.content}
						{index < visible.length - 1 ? null : null}
					</div>
				))
				.flatMap((node, index) =>
					index < visible.length - 1
						? [
								node,
								<div
									key={`divider-${visible[index].key}`}
									className={`pmr-divider pmr-divider--${isHorizontal ? "v" : "h"}`}
									data-dragging={draggingIndex === index}
									onPointerDown={(event) => beginDrag(index, event)}
									role="separator"
									aria-orientation={isHorizontal ? "vertical" : "horizontal"}
								/>,
							]
						: [node],
				)}
		</div>
	);
}
