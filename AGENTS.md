# Agent Instructions

This repository is Julian's personal Pi package. It contains TypeScript extensions, skills, prompts, and themes that are loaded by the Pi coding agent.

## Repository map

- `package.json` — package metadata and the Pi package manifest. The `pi` key controls which resources Pi loads.
- `extensions/*.ts` — single-file Pi extensions. Each file should default-export a function receiving `ExtensionAPI`.
- `extensions/subthread/` — the persistent sub-thread extension plus its `SKILL.md` instructions.
- `README.md` — user-facing documentation for installed tools/extensions.
- `tsconfig.json` — strict TypeScript config covering `extensions/**/*.ts`.

## Development commands

Use `pnpm` in this repository.

```bash
pnpm install
pnpm typecheck
```

Run `pnpm typecheck` after changing extension code.

## Pi extension practices

- Follow Pi's extension API docs when adding or changing extensions:
  - main docs: `/Users/jb/.local/share/fnm/node-versions/v22.21.1/installation/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
  - package docs: `/Users/jb/.local/share/fnm/node-versions/v22.21.1/installation/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
  - examples: `/Users/jb/.local/share/fnm/node-versions/v22.21.1/installation/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/`
- Prefer simple single-file extensions in `extensions/` unless shared state/helpers justify a directory.
- Extensions run with full local permissions. Be careful with destructive filesystem or git operations; prefer clear user-facing notifications and safe cleanup paths.
- Slash commands receive raw argument strings. If you need structured arguments, parse them deliberately and document the invocation syntax in the command description and README.
- For long-running child processes, wire cancellation through an `AbortSignal` when available and clean up child processes on abort.
- Truncate large child-process output before returning or displaying it to avoid overwhelming Pi context/UI.
- Keep child Pi invocations consistent with the parent session when appropriate: inherit model, thinking level, and active tools.
- Store persistent extension state in session entries via `pi.appendEntry()` when it should survive reloads or session resumes.

## TypeScript/code style

- Use strict TypeScript. Avoid `any` unless interop with Pi event payloads requires it.
- Use Node built-in modules via `node:` imports.
- Keep helper functions small and close to the extension that uses them.
- Validate/sanitize user-provided names before using them in filesystem paths, branch names, tmux sessions, etc.
- Prefer `pi.exec()` inside command handlers when command output should follow Pi's execution environment; use `spawn` only when streaming or process lifecycle control is needed.

## Documentation expectations

When adding a new user-facing command or tool:

1. Add or update its section in `README.md`.
2. Include invocation examples and required environment variables, if any.
3. Mention where files/sessions/artifacts are written.

## Git hygiene

- Check `git status --short` before committing. Do not accidentally include unrelated local files.
- Commit focused changes with a descriptive message.
- If asked to publish changes, push the current branch after committing.
