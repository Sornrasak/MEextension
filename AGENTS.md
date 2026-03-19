# AGENTS.md

## Cursor Cloud specific instructions

### Project overview
MEextension is a manga/comic page extractor with two delivery mechanisms:
1. **CLI tool** (`cli/extract.ts`) — Puppeteer-based, runs from terminal, fully automatable.
2. **Chrome extension** (`chrome/manifest.json`) — Overlay UI, manual use in the browser.

Both share the same handler scripts from `app/handlers/`. No backend services or databases.

### Key commands
See `package.json` scripts and `.cursor/rules/cli-workflow.mdc` for full reference.
- `bun install` — install dependencies
- `bun run build` — clean build to `./build` (extension + handler IIFE bundles)
- `bun run dev` — build with `--watch` for file-change rebuilds
- `bun run lint` — ESLint on `src/`
- `bun run format` — Prettier on `src/`
- `bun cli/extract.ts --reader <name> --url <url> [--out ./output]` — CLI extraction
- `bun cli/verify.ts --input <path>` — verify extracted images + generate viewer.html
- `bun cli/nico-account.ts ensure` — create/reuse Nico account with automated email MFA
- `bun cli/nico-account.ts scrape --url <url>` — auth + extract from manga.nicovideo.jp

### Runtime: Bun
The project uses **Bun** as its package manager and build tool. Bun must be on `$PATH` (`~/.bun/bin`). A `bun.lock` lockfile is present; ignore the legacy `pnpm-lock.yaml`.

### CLI extraction workflow
The primary development workflow is CLI-based. Always `bun run build` before extraction (handlers are built as IIFE bundles injected by Puppeteer). Puppeteer downloads its own Chromium to `~/.cache/puppeteer/`.

Quick smoke test: `bun run build && bun cli/extract.ts --reader takecomic --url "https://takecomic.jp/episodes/4a68a7464bf1f" --out ./output/test && bun cli/verify.ts --input ./output/test`

### Testing the Chrome extension
1. Run `bun run build`.
2. Open Chrome → `chrome://extensions/` → Enable **Developer mode** → **Load unpacked** → select `./build`.
3. Navigate to a supported manga site and click the extension icon to toggle the overlay.

There are no automated tests. Lint (`bun run lint`) is the primary code-quality check.

### Handler development
Read `.cursor/rules/handler-development.mdc` for the full guide. **Always read `app/handlers/NOTES.md` before working on handlers and update it after.**

### Gotchas
- The ESLint config (`eslint.config.js`) uses ESLint 9 flat config and imports `globals` — make sure `node_modules` is present before running lint.
- Build output goes to `./build`; this directory is git-ignored.
- Tailwind CSS processing may warn about outdated `caniuse-lite` data — this is cosmetic.
- Puppeteer requires `--no-sandbox` in this environment (already set in `puppeteer-runner.ts`).
- Extraction to manga sites requires network access; some handlers require authentication (use `--login` flag for first-time login, cookies are persisted to `cli/cookies/`).
- `cli/nico-account.ts` needs env vars `AUTOMATION_EMAIL` and `ME1_APP_PASS` (Gmail app password) for automated email MFA. See `bun cli/nico-account.ts --help` for all options.
