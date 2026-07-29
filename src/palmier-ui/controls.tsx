// Shared controls. Native `accent-color` renders a platform slider that ignores
// the app's own design language, so every range in the editor goes through
// `Slider`, which draws AppTheme.Slider's spec: a 4px track, a 10px thumb, and a
// filled portion that shows the value without needing to read the number.

import { useCallback, useId, useRef, useState } from "react";

interface SliderProps {
	value: number;
	min: number;
	max: number;
	step?: number;
	onChange: (next: number) => void;
	/** Value the track fills out from — 0 for magnitude, midpoint for bipolar. */
	origin?: number;
	/** Paints the track itself (temperature, tint). Fill is suppressed when set. */
	trackImage?: string;
	disabled?: boolean;
	ariaLabel?: string;
	className?: string;
}

export function Slider({
	value,
	min,
	max,
	step = 0.01,
	onChange,
	origin,
	trackImage,
	disabled,
	ariaLabel,
	className,
}: SliderProps) {
	const span = max - min || 1;
	const position = ((value - min) / span) * 100;
	// A bipolar control reads better filling out from its neutral point than from
	// the left edge: you see the sign of the adjustment, not just its size.
	const originPercent = origin === undefined ? 0 : ((origin - min) / span) * 100;
	const fillStart = Math.min(position, originPercent);
	const fillEnd = Math.max(position, originPercent);

	return (
		<input
			type="range"
			className={`pmr-range${className ? ` ${className}` : ""}`}
			min={min}
			max={max}
			step={step}
			value={value}
			disabled={disabled}
			aria-label={ariaLabel}
			onChange={(event) => onChange(Number(event.target.value))}
			style={
				{
					"--pmr-range-pos": `${position}%`,
					"--pmr-range-fill-start": `${fillStart}%`,
					"--pmr-range-fill-end": `${fillEnd}%`,
					"--pmr-range-track": trackImage ?? "none",
				} as React.CSSProperties
			}
			data-tinted={trackImage ? "true" : undefined}
		/>
	);
}

interface NumberFieldProps {
	value: number;
	onChange: (next: number) => void;
	/** Units per pixel of horizontal drag. */
	step?: number;
	suffix?: string;
	width?: number;
	precision?: number;
	disabled?: boolean;
	ariaLabel?: string;
}

/**
 * ScrubbableNumberField — drag horizontally to change, or click to type. The
 * pointer is captured so the drag survives leaving the field, and a drag that
 * never moves falls through to a normal text caret.
 */
export function NumberField({
	value,
	onChange,
	step = 1,
	suffix,
	width,
	precision = 3,
	disabled,
	ariaLabel,
}: NumberFieldProps) {
	const [draft, setDraft] = useState<string | null>(null);
	const [scrubbing, setScrubbing] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const beginScrub = useCallback(
		(event: React.PointerEvent<HTMLInputElement>) => {
			if (disabled || event.button !== 0) return;
			const startX = event.clientX;
			const startValue = value;
			let moved = false;

			const onMove = (moveEvent: PointerEvent) => {
				const delta = moveEvent.clientX - startX;
				if (!moved && Math.abs(delta) > 2) {
					moved = true;
					setScrubbing(true);
				}
				if (moved) {
					// Shift is the fine-adjust modifier throughout the editor.
					const scale = moveEvent.shiftKey ? step / 5 : step;
					onChange(Number((startValue + delta * scale).toFixed(4)));
				}
			};
			const onUp = () => {
				setScrubbing(false);
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				// A click that never became a drag should place a caret instead.
				if (!moved) inputRef.current?.select();
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[disabled, onChange, step, value],
	);

	const shown = draft ?? String(Number(value.toFixed(precision)));

	return (
		<span className="pmr-numwrap" data-scrubbing={scrubbing || undefined}>
			<input
				ref={inputRef}
				className="pmr-num"
				style={width ? { width } : undefined}
				value={shown}
				disabled={disabled}
				aria-label={ariaLabel}
				onPointerDown={beginScrub}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					if (draft === null) return;
					const parsed = Number(draft);
					if (Number.isFinite(parsed)) onChange(parsed);
					setDraft(null);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
					if (event.key === "Escape") {
						setDraft(null);
						event.currentTarget.blur();
					}
					// Arrow keys nudge, matching the scrub's shift modifier.
					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault();
						const direction = event.key === "ArrowUp" ? 1 : -1;
						const scale = event.shiftKey ? step / 5 : step;
						onChange(Number((value + direction * scale * 10).toFixed(4)));
					}
				}}
			/>
			{suffix ? <span className="pmr-num__suffix">{suffix}</span> : null}
		</span>
	);
}

interface SwitchProps {
	checked: boolean;
	onChange: (next: boolean) => void;
	label?: string;
	disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
	const id = useId();
	return (
		<button
			type="button"
			id={id}
			role="switch"
			aria-checked={checked}
			aria-label={label}
			className="pmr-switch"
			disabled={disabled}
			onClick={() => onChange(!checked)}
		>
			<span className="pmr-switch__knob" />
		</button>
	);
}

/** Segmented control — the editor's choice-of-few, replacing radio rows. */
export function Segmented<T extends string>({
	options,
	value,
	onChange,
	ariaLabel,
}: {
	options: ReadonlyArray<{ value: T; label: string; title?: string }>;
	value: T;
	onChange: (next: T) => void;
	ariaLabel?: string;
}) {
	return (
		<div className="pmr-seg" role="radiogroup" aria-label={ariaLabel}>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={value === option.value}
					className="pmr-seg__btn"
					data-active={value === option.value}
					title={option.title}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export function Select<T extends string>({
	options,
	value,
	onChange,
	ariaLabel,
}: {
	options: ReadonlyArray<{ value: T; label: string }>;
	value: T;
	onChange: (next: T) => void;
	ariaLabel?: string;
}) {
	return (
		<span className="pmr-selectwrap">
			<select
				className="pmr-select"
				value={value}
				aria-label={ariaLabel}
				onChange={(event) => onChange(event.target.value as T)}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
			<svg
				className="pmr-selectwrap__chevron"
				width="8"
				height="8"
				viewBox="0 0 8 8"
				aria-hidden="true"
			>
				<path
					d="M1 2.5 4 5.5 7 2.5"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		</span>
	);
}

export function ColorField({
	value,
	onChange,
	ariaLabel,
}: {
	value: string;
	onChange: (next: string) => void;
	ariaLabel?: string;
}) {
	return (
		<span className="pmr-colorfield">
			<input
				type="color"
				value={value}
				aria-label={ariaLabel}
				onChange={(event) => onChange(event.target.value)}
			/>
			<span className="pmr-colorfield__hex">{value.toUpperCase()}</span>
		</span>
	);
}
