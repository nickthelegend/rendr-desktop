// Browser-only Vite config for iterating on the renderer without launching
// Electron. Same aliases as vite.config.ts, no electron plugin.
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	// Pinned so the server can be launched from a parent directory.
	root: __dirname,
	plugins: [react()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		port: 5199,
		strictPort: true,
	},
});
