const path = require("node:path");

/**
 * Tailwind is pointed at its config explicitly.
 *
 * The plugin's own discovery looks in the *current working directory*, not the
 * Vite root — so launching the dev server from a parent directory found no
 * config, every theme extension vanished, and `@apply border-border` in
 * index.css failed with "the `border-border` class does not exist". Naming the
 * file makes the build independent of where it was started from.
 */
module.exports = {
	plugins: {
		tailwindcss: { config: path.join(__dirname, "tailwind.config.cjs") },
		autoprefixer: {},
	},
};
