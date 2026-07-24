---
project_name: "OpenWhispr"
user_name: "lpodobnik0"
date: "2026-07-24"
sections_completed:
  [
    "technology_stack",
    "language_rules",
    "framework_rules",
    "testing_rules",
    "quality_rules",
    "workflow_rules",
    "anti_patterns",
  ]
status: "complete"
rule_count: 36
optimized_for_llm: true
existing_patterns_found: 17
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

OpenWhispr is an Electron desktop dictation app (speech-to-text via whisper.cpp / Parakeet / cloud APIs). Full architecture lives in `CLAUDE.md` at the repo root — read it for *how the system works*. This file is only the rules you must not violate.

---

## Technology Stack & Versions

- **Node 24**, pinned in `.nvmrc`, with `engine-strict=true` in `.npmrc`. **Never regenerate `package-lock.json` on a different Node major** — CI uses 24.
- **Electron 41** (context isolation on) · **React 19** · **TypeScript 6** · **Vite 8** · **Tailwind 4**
- **better-sqlite3 12.9** (native module) · **Kysely** query builder · **Qdrant** for semantic search
- **onnxruntime-node 1.21** · whisper.cpp · sherpa-onnx (Parakeet) · ffmpeg-static
- **Vercel AI SDK 6** with 7 providers (OpenAI, Anthropic, Google, Vertex, Bedrock, Azure, Groq)
- **zustand 5** state · **shadcn/ui + Radix** components · **i18next 26 / react-i18next 17**
- **TipTap is pinned to exactly `3.22.5`** across ~25 entries in `package.json` `overrides`. Never bump a single TipTap package in isolation — they must move together or the editor breaks.

## Critical Implementation Rules

### Language-Specific Rules

- **Two module systems in one repo.** Repo root (main process) is **CommonJS** — use `require`/`module.exports`. `src/` (renderer) is **ESM** — use `import`/`export`. The root `eslint.config.js` explicitly ignores `src/**` because `src/` has its own config. Getting this wrong per-directory fails silently.
- **`tsconfig.json` lives in `src/`, not the repo root**, and sets `strict: false`. Do not assume strict null checking; do not "fix" code by assuming it's on.
- **Path alias `@/*` → `./*` is only valid inside `src/`.** It does not resolve in main-process code.
- Mixed language reality: ~135 `.js`, ~102 `.ts`, ~48 `.tsx`. **New React components in TypeScript**; helpers are largely JS. Match the conventions of the file you are editing rather than converting it.
- `allowImportingTsExtensions` and `isolatedModules` are on — every file must be independently transpilable (no cross-file `const enum`, use `export type` for type-only re-exports).

### Framework-Specific Rules

- **Dual-window architecture**: a minimal always-on-top dictation overlay and a full control panel, both served from the same React codebase and selected by URL routing. A change to shared components affects both — check both.
- **State is zustand**, 12 stores in `src/stores/*.ts` (all TypeScript). Add new global state as a store there, not React Context.
- **All `onnxruntime-node` inference must go through the ONNX utility process** (`src/helpers/onnxWorkerClient.js` → `src/workers/onnxWorker.js`). Never call ONNX directly from the main process — the worker exists so native crashes (e.g. ORT `bad_alloc`) stay confined and can be respawned.
- **A new IPC channel must be added in two places**: `ipcHandlers.js` *and* `preload.js`. One without the other is a silent no-op.
- New UI components follow the shadcn/ui patterns in `src/components/ui`. New managers go in `src/helpers/` and are initialized in `main.js`. New settings touch `useSettings.ts` *and* `SettingsPage.tsx`.

### Testing Rules

- **The test runner is `node --test`** over `test/**/*.test.js` (~81 files). This is not Jest and not Vitest — no `describe`/`expect` from a framework, use `node:test` + `node:assert`.
- **DB-backed tests SKIP rather than FAIL when better-sqlite3 isn't built.** CI does `npm ci --ignore-scripts` then `npm rebuild better-sqlite3` precisely for this. A green run with no DB coverage is the failure mode to watch for — verify the DB tests actually ran.
- CI sets `ELECTRON_OVERRIDE_DIST_PATH` so `require("electron")` doesn't throw when postinstall was skipped.
- `npm run typecheck` is `cd src && tsc --noEmit` — running `tsc` from the repo root checks nothing.

### Code Quality & Style Rules

- **Prettier**: 100 columns, **double quotes**, semicolons, `es5` trailing commas, LF endings, `arrowParens: always`.
- **Lint and typecheck must be run from both roots**: `npm run lint` = `eslint . && cd src && eslint .`. Checking only one half misses the other.
- `npm run quality-check` = `format:check` + `typecheck`. Run it before declaring work done.
- `no-console` is **off** deliberately — comprehensive debug logging is expected, not a smell. `no-empty` allows empty catch blocks.
- Unused-variable warnings are suppressed for `^_` prefixes (and `^event|^err|^error` args); in `src/`, also for `^[A-Z_]`.

### Development Workflow Rules

- **Conventional Commits with a scope and trailing PR number**: `fix(parakeet): fall back to full decode when the streaming commit loses audio (#1285)`. Scopes seen in history: `parakeet`, `models`, `translation`, `linux`, plus bare `fix:`, `feat:`, `ci:`, `docs:`, `chore:`.
- **Branches are `fix/...` or `feat/...`**, sometimes prefixed by contributor (`dpersek/fix/...`).
- CI on every PR runs typecheck + tests on Ubuntu; separate workflows handle per-platform native builds, CodeQL, and lockfile linting.

### Critical Don't-Miss Rules

- **i18n is mandatory.** Never hardcode a user-facing string. Every new string needs a key in **all 10 locale directories**: `de, en, es, fr, it, ja, pt, ru, zh-CN, zh-TW`. ⚠️ `CLAUDE.md`'s prose list of "supported languages" omits `ja` and is stale — trust `src/locales/`. Verify with `npm run i18n:check`.
  - Do **not** translate: brand names (OpenWhispr, Pro), technical terms (Markdown, Signal ID), format names (MP3, WAV), or AI system prompts.
  - Group keys by feature area (`notes.editor.*`), keep `{{variable}}` interpolation.
- **Adding a sidecar binary is a 6-step protocol** — miss a step and processes leak: download script in `scripts/`, wire into the `prebuild*` scripts, manager in `src/helpers/`, spawn with `detached: process.platform !== "win32"`, `sidecarPidFile.write(name, child.pid)` on spawn and `.clear(name)` on close, add the binary fragment to `EXPECTED_BINARY_FRAGMENTS` in `sidecarReaper.js`, and register via `sidecarRegistry.register(name, () => manager.stop())`.
- **Secrets never go to plaintext.** All 12 API keys / cloud creds use Electron `safeStorage` → OS keychain, stored per-key under `userData/secure-keys/`. (Known gap: Linux without a keyring falls back to plaintext — Electron default.)
- **Hard limits**: audio blobs over IPC cap at **10MB**; external processes have a **5-minute** timeout. Always clean up temp files and listeners — the audio pipeline writes temp files per recording.
- Context isolation is on and the IPC surface is deliberately small. **No remote code execution**; sanitize any file path crossing the IPC boundary.
- Meeting detection is event-driven via OS APIs with a polling fallback; the process-list cache is shared between detectors. Don't add a second independent `tasklist`/`pgrep` poller.

---

## Usage Guidelines

**For AI Agents:**

- Read this file before implementing any code
- Follow ALL rules exactly as documented
- When in doubt, prefer the more restrictive option
- Update this file if new patterns emerge

**For Humans:**

- Keep this file lean and focused on agent needs
- Update when technology stack changes
- Review periodically for outdated rules
- Remove rules that become obvious over time

Last Updated: 2026-07-24
