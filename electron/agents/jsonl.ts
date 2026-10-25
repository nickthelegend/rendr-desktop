import type { Readable } from "node:stream";

/** Calls `onLine` with every complete, non-empty line a stream produces. */
export function readLines(stream: Readable, onLine: (line: string) => void): void {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard line-splitting loop
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) onLine(line);
		}
	});
	stream.on("end", () => {
		const rest = buffer.trim();
		buffer = "";
		if (rest) onLine(rest);
	});
}

export function parseJson(line: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(line) as unknown;
		return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Runs `binary --version` (or the given args) and reports what it printed. */
export async function probeVersion(
	binary: string,
	env: NodeJS.ProcessEnv,
	args: string[] = ["--version"],
): Promise<{ ok: boolean; output: string; code: number | null; missing: boolean }> {
	const { spawn } = await import("node:child_process");
	return await new Promise((resolve) => {
		let output = "";
		let settled = false;
		const finish = (value: {
			ok: boolean;
			output: string;
			code: number | null;
			missing: boolean;
		}) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			finish({ ok: false, output: "", code: null, missing: true });
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ ok: false, output, code: null, missing: false });
		}, 15_000);
		child.stdout?.on("data", (chunk) => {
			output += String(chunk);
		});
		child.on("error", () => finish({ ok: false, output, code: null, missing: true }));
		child.on("close", (code) =>
			finish({ ok: code === 0, output: output.trim(), code, missing: false }),
		);
	});
}
