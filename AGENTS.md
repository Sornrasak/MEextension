# AGENTS.md

## Cursor Cloud specific instructions

### Project overview
MEextension is a Chrome extension (Manifest V3) for extracting manga images from various online reader sites. It is a purely client-side project with no backend services or databases.

### Build & dev commands
See `package.json` scripts. Key commands:
- `bun install` — install dependencies
- `bun run build` — clean build to `./build`
- `bun run dev` — build with `--watch` for file-change rebuilds
- `bun run lint` — ESLint on `src/`
- `bun run format` — Prettier on `src/`

### Runtime: Bun
The project uses **Bun** as its package manager and build tool. Bun must be on `$PATH` (`~/.bun/bin`). A `bun.lock` lockfile is present; ignore the legacy `pnpm-lock.yaml`.

### Testing the extension
This is a Chrome extension — there is no dev server or URL to visit. To test:
1. Run `bun run build` (or leave `bun run dev` running for watch mode).
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode**, click **Load unpacked**, and select the `./build` directory.
4. Navigate to a supported manga site (e.g. `comic-walker.com`) and click the extension icon to toggle the overlay.

There are no automated tests in this project yet. Lint (`bun run lint`) is the primary code-quality check.

### Gotchas
- The ESLint config (`eslint.config.js`) uses ESLint 9 flat config and imports `globals` — make sure `node_modules` is present before running lint.
- Build output goes to `./build`; this directory is git-ignored.
- Tailwind CSS processing happens at the end of the build step and may warn about outdated `caniuse-lite` data — this is cosmetic.
