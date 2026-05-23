import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";

const DEFAULT_SESSION_PREFIX = "pi";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("echo", {
    description: "Handoff the current Pi session into a named tmux session for Echo/iOS SSH access",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("/echo needs a persisted Pi session. Restart Pi without --no-session, then try again.", "error");
        return;
      }

      const parsed = parseArgs(args);
      const tmuxSession = parsed.sessionName ?? defaultSessionName(ctx.cwd);

      if (process.env.TMUX) {
        ctx.ui.notify(formatAlreadyInTmux(tmuxSession), "info");
        return;
      }

      const hasTmux = await commandExists(pi, "tmux");
      if (!hasTmux) {
        ctx.ui.notify("tmux is not installed or not on PATH. Install it with `brew install tmux`.", "error");
        return;
      }

      const existing = await pi.exec("tmux", ["has-session", "-t", tmuxSession]);
      if (existing.code === 0) {
        ctx.ui.notify(formatAttachInstructions(tmuxSession, "A tmux session with that name already exists."), "info");
        ctx.shutdown();
        return;
      }

      const result = await pi.exec("tmux", ["new-session", "-d", "-s", tmuxSession, "-c", ctx.cwd, "zsh"]);
      if (result.code !== 0) {
        ctx.ui.notify(
          [`Failed to create tmux session '${tmuxSession}'.`, result.stderr || result.stdout].filter(Boolean).join("\n"),
          "error",
        );
        return;
      }

      pi.appendEntry("echo-handoff", {
        tmuxSession,
        cwd: ctx.cwd,
        sessionFile,
        timestamp: Date.now(),
      });

      const handoffScript = buildDeferredPiCommand({
        cwd: ctx.cwd,
        sessionFile,
        parentPid: process.pid,
      });
      const sendResult = await pi.exec("tmux", ["send-keys", "-t", tmuxSession, handoffScript, "C-m"]);
      if (sendResult.code !== 0) {
        ctx.ui.notify(
          [`Created tmux session '${tmuxSession}', but failed to queue Pi startup.`, sendResult.stderr || sendResult.stdout]
            .filter(Boolean)
            .join("\n"),
          "error",
        );
        return;
      }

      ctx.ui.notify(formatAttachInstructions(tmuxSession, "Handoff queued. This Pi will exit; tmux will resume it."), "info");
      ctx.shutdown();
    },
  });
}

function parseArgs(args: string | undefined) {
  const trimmed = args?.trim();
  if (!trimmed) return { sessionName: undefined };

  const first = trimmed.split(/\s+/)[0];
  return { sessionName: sanitizeTmuxSessionName(first) };
}

function defaultSessionName(cwd: string) {
  return sanitizeTmuxSessionName(`${DEFAULT_SESSION_PREFIX}-${path.basename(cwd)}`);
}

function sanitizeTmuxSessionName(value: string) {
  const sanitized = value
    .trim()
    .replace(/^[/:.]+/, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .slice(0, 80);

  return sanitized || "pi-echo";
}

async function commandExists(pi: ExtensionAPI, command: string) {
  const result = await pi.exec("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`]);
  return result.code === 0;
}

function buildDeferredPiCommand(options: { cwd: string; sessionFile: string; parentPid: number }) {
  return [
    `while kill -0 ${options.parentPid} 2>/dev/null; do sleep 0.2; done`,
    `cd ${shellQuote(options.cwd)}`,
    `pi --session ${shellQuote(options.sessionFile)}`,
    `printf '\\nPi exited. This tmux shell is still alive. Run ` + shellQuote(`pi --session ${options.sessionFile}`) + ` to resume.\\n'`,
  ].join("; ");
}

function formatAttachInstructions(tmuxSession: string, prefix: string) {
  return [
    prefix,
    "",
    "Attach locally or from Echo over SSH with:",
    `  tmux attach -t ${tmuxSession}`,
    "",
    "Detach without stopping Pi:",
    "  Ctrl-b then d",
  ].join("\n");
}

function formatAlreadyInTmux(tmuxSession: string) {
  return [
    "This Pi is already running inside tmux.",
    "",
    "From Echo, SSH to this machine and attach with:",
    `  tmux attach -t ${tmuxSession}`,
    "",
    "If that name is not right, run `tmux display-message -p '#S'` inside this terminal to see the actual session name.",
  ].join("\n");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
