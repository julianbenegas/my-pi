# my-pi

Julian's personal [Pi](https://github.com/earendil-works/pi-coding-agent) package: extensions, skills, prompts, and themes.

## Install locally into a project

From this repository:

```bash
pi install -l .
```

From another project:

```bash
pi install -l /Users/jb/Documents/work/my-pi
```

Then run `/reload` in Pi.

## Extensions

### `web_fetch`

Registers a Pi tool named `web_fetch` that fetches a URL with text/markdown-oriented `Accept` headers and returns `response.text()`.

Tool options:

- `url` — URL to fetch

### `/btworktree`

Registers a Pi slash command that runs unrelated work in an isolated git worktree with a fresh child Pi session.

Usage:

```text
/btworktree <base-branch>/<worktree-name> <prompt>
```

Examples:

```text
/btworktree main/some-name do some work unrelated to what we're doing
/btworktree feature/foo/bar/spike try an experiment from feature/foo/bar
```

Behavior:

- creates the worktree at `~/.pi/worktrees/<cwd-name>/<worktree-name>`
- creates a fresh persisted Pi session for that worktree
- runs the prompt in a child Pi session that inherits the parent model, thinking level, and active tools
- loops with the child Pi until there is a final outcome:
  - **discard**: the worktree is reset/cleaned back to the base branch
  - **keep**: the child commits the work and pushes the worktree branch with upstream tracking
- deletes the local worktree directory after either final outcome

### `generate_image`

Registers a Pi tool named `generate_image` that uses the Vercel AI Gateway image model `openai/gpt-image-2` through the AI SDK's `generateImage()` API.

Auth is expected via the AI SDK Gateway provider. Set one of:

```bash
export AI_GATEWAY_API_KEY_CODING_AGENT=...
# or:
export AI_GATEWAY_API_KEY=...
# or:
export VERCEL_AI_GATEWAY_API_KEY=...
```

Generated files are written to `.pi/generated-images/` in the current Pi working directory by default.

Tool options include:

- `prompt` — required image prompt
- `model` — Vercel AI Gateway image model, default `openai/gpt-image-2`; agents should not override this unless the user explicitly asks for a different model
- `n` — number of images, default `1`
- `size` — e.g. `1024x1024`
- `aspectRatio` — e.g. `16:9`; do not pass with `size`
- `seed`
- `outputDir` — override output directory
- `fileNamePrefix` — override generated filename prefix

## Development

```bash
pnpm install
pnpm typecheck
```
