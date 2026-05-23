import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";

const COMMAND = "btworktree";
const WORKTREE_PREFIX = "pi-btworktree";
const MAX_OUTPUT_BYTES = 50 * 1024;

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

interface ParsedArgs {
  name: string;
  target: string;
  prompt: string;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface WorktreeRecord {
  name: string;
  root: string;
  path: string;
  branch: string;
  target: string;
  sessionFile: string;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand(COMMAND, {
    description: "Run a prompt in a fresh git worktree: /btworktree <base-branch>/<worktree-name> <prompt>",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      let parsed: ParsedArgs;
      try {
        parsed = await parseArgs(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      const record = await createWorktree(parsed, ctx);
      ctx.ui.notify(`Created worktree ${record.path} on ${record.branch} from ${record.target}.`, "info");
      ctx.ui.setStatus(COMMAND, `btworktree: ${record.name}`);
      ctx.ui.setWidget(COMMAND, [`btworktree ${record.name}`, `path: ${record.path}`, `branch: ${record.branch}`, "status: running"]);

      const inherited = getInheritedOptions(pi, ctx);
      const initial = buildInitialPrompt(parsed.prompt, record);
      const first = await runPi(record.path, record.sessionFile, initial, inherited, ctx.signal);

      const dirtyAfterFirst = await hasGitChanges(record.path);
      if (!dirtyAfterFirst) {
        ctx.ui.setWidget(COMMAND, [`btworktree ${record.name}`, "status: no git changes; cleaning up"]);
        await removeWorktree(record);
        ctx.ui.notify(`btworktree ${record.name}: child Pi finished with no git changes; removed ${record.path}.`, "info");
        ctx.ui.setStatus(COMMAND, undefined);
        ctx.ui.setWidget(COMMAND, undefined);
        return;
      }

      ctx.ui.setWidget(COMMAND, [
        `btworktree ${record.name}`,
        `path: ${record.path}`,
        `branch: ${record.branch}`,
        "status: uncommitted changes detected; asking child to decide keep vs discard",
      ]);

      const statusBeforeDecision = await gitStatus(record.path);
      const decisionPrompt = buildDecisionPrompt(statusBeforeDecision);
      const second = await runPi(record.path, record.sessionFile, decisionPrompt, inherited, ctx.signal);
      const dirtyAfterDecision = await hasGitChanges(record.path);

      if (!dirtyAfterDecision) {
        await removeWorktree(record);
        ctx.ui.notify(`btworktree ${record.name}: child discarded/reset changes; removed ${record.path}.`, "info");
        ctx.ui.setStatus(COMMAND, undefined);
        ctx.ui.setWidget(COMMAND, undefined);
        return;
      }

      ctx.ui.setWidget(COMMAND, [
        `btworktree ${record.name}`,
        `path: ${record.path}`,
        `branch: ${record.branch}`,
        "status: changes kept",
      ]);

      const finalStatus = await gitStatus(record.path);
      ctx.ui.notify(
        [
          `btworktree ${record.name}: changes kept in ${record.path}`,
          `branch: ${record.branch}`,
          `session: ${record.sessionFile}`,
          "",
          capBytes(finalStatus.stdout || finalStatus.stderr || "(no git status output)", 4000),
          first.code === 0 && second.code === 0 ? undefined : "",
          first.code !== 0 ? `Initial child Pi exit code: ${first.code}\n${capBytes(first.stderr, 4000)}` : undefined,
          second.code !== 0 ? `Decision child Pi exit code: ${second.code}\n${capBytes(second.stderr, 4000)}` : undefined,
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n"),
        "info",
      );
      ctx.ui.setStatus(COMMAND, undefined);
    },
  });
}

async function parseArgs(rawArgs: string, ctx: CommandContext): Promise<ParsedArgs> {
  const match = rawArgs.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) throw new Error(usage());

  const spec = match[1];
  const separator = spec.lastIndexOf("/");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`Expected <base-branch>/<worktree-name>.\n\n${usage()}`);
  }

  const target = spec.slice(0, separator);
  const name = spec.slice(separator + 1);
  if (!isSafeName(name)) {
    throw new Error(`Invalid worktree name: ${name}\nUse only letters, numbers, dot, underscore, and dash.`);
  }

  const inlinePrompt = stripBalancedOuterQuotes(match[2]?.trim() ?? "");
  if (inlinePrompt) return { name, target, prompt: inlinePrompt };

  const prompt = await ctx.ui.editor("btworktree prompt", "");
  if (!prompt?.trim()) throw new Error(usage());
  return { name, target, prompt: prompt.trim() };
}

async function createWorktree(parsed: ParsedArgs, ctx: CommandContext): Promise<WorktreeRecord> {
  const root = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd })).stdout.trim();
  if (!root) throw new Error("Not inside a git repository.");

  const worktreesDir = join(homedir(), ".pi", "worktrees", sanitizePathSegment(basename(root)));
  await mkdir(worktreesDir, { recursive: true });
  const path = join(worktreesDir, parsed.name);
  const branch = `${WORKTREE_PREFIX}/${parsed.name}`;

  await exec("git", ["worktree", "add", "-b", branch, path, parsed.target], { cwd: root, rejectOnError: true });

  const sm = SessionManager.create(path);
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) throw new Error("Failed to create a persisted Pi session for the worktree.");

  return { name: parsed.name, root, path, branch, target: parsed.target, sessionFile };
}

function getInheritedOptions(pi: ExtensionAPI, ctx: CommandContext) {
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  return {
    model,
    thinking: pi.getThinkingLevel(),
    tools: pi.getActiveTools(),
  };
}

function buildInitialPrompt(prompt: string, record: WorktreeRecord) {
  return [
    "You are a fresh Pi session spawned by /btworktree in an isolated git worktree.",
    `Worktree path: ${record.path}`,
    `Branch: ${record.branch}`,
    `Base target: ${record.target}`,
    "Work independently. Keep your changes inside this worktree. Do not touch the parent worktree.",
    "If you decide the task should not leave changes, explicitly reset/discard your work before finishing.",
    "If you do leave changes, summarize what changed and how you validated it.",
    "",
    "User prompt:",
    prompt,
  ].join("\n");
}

function buildDecisionPrompt(status: ExecResult) {
  return [
    "Your previous run left uncommitted git changes in this worktree.",
    "Decide whether these changes should be kept or discarded.",
    "- If they should be kept, leave the git changes as-is and explain why they are worth keeping.",
    "- If they should not be kept, reset/discard all changes so that `git status --porcelain` is empty, then explain why.",
    "",
    "Current git status:",
    "```",
    capBytes(status.stdout || status.stderr || "(no output)", 12000),
    "```",
  ].join("\n");
}

async function runPi(
  cwd: string,
  sessionFile: string,
  prompt: string,
  inherited: { model?: string; thinking?: string; tools?: string[] },
  signal: AbortSignal | undefined,
): Promise<ExecResult> {
  const args = ["-p", "--session", sessionFile];
  if (inherited.model) args.push("--model", inherited.model);
  if (inherited.thinking) args.push("--thinking", inherited.thinking);
  if (inherited.tools?.length) args.push("--tools", inherited.tools.join(","));
  args.push(prompt);
  return spawnPi(args, cwd, signal);
}

function spawnPi(args: string[], cwd: string, signal?: AbortSignal): Promise<ExecResult> {
  const invocation = getPiInvocation(args);
  return new Promise((resolve) => {
    const proc = spawn(invocation.command, invocation.args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let aborted = false;

    proc.stdout.on("data", (data) => {
      stdout = capBytes(stdout + data.toString(), MAX_OUTPUT_BYTES);
    });
    proc.stderr.on("data", (data) => {
      stderr = capBytes(stderr + data.toString(), MAX_OUTPUT_BYTES);
    });
    proc.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: stderr ? `${stderr}\n${error.message}` : error.message });
    });
    proc.on("close", (code) => {
      resolve({ code: aborted ? 130 : (code ?? 0), stdout, stderr: aborted ? `${stderr}\nAborted.` : stderr });
    });

    const abort = () => {
      aborted = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000).unref();
    };

    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript) return { command: process.execPath, args: [currentScript, ...args] };
  return { command: "pi", args };
}

async function hasGitChanges(cwd: string) {
  const status = await exec("git", ["status", "--porcelain"], { cwd });
  return status.stdout.trim().length > 0;
}

function gitStatus(cwd: string) {
  return exec("git", ["status", "--short", "--branch"], { cwd });
}

async function removeWorktree(record: WorktreeRecord) {
  await exec("git", ["worktree", "remove", "--force", record.path], { cwd: record.root });
  await rm(record.path, { recursive: true, force: true });
}

function exec(
  command: string,
  args: string[],
  options: { cwd: string; rejectOnError?: boolean },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      const result = { code: code ?? 0, stdout, stderr };
      if (options.rejectOnError && result.code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed (${result.code}):\n${stderr || stdout}`));
        return;
      }
      resolve(result);
    });
  });
}

function stripBalancedOuterQuotes(value: string) {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return value;
  return value.slice(1, -1).replace(/\\([\\"'])/g, "$1");
}

function sanitizePathSegment(value: string) {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-");
  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "repo";
}

function isSafeName(name: string) {
  return /^[A-Za-z0-9._-]+$/.test(name) && basename(name) === name && name !== "." && name !== "..";
}

function usage() {
  return [
    `Usage: /${COMMAND} <base-branch>/<worktree-name> <prompt>`,
    "Examples:",
    `  /${COMMAND} main/some-name do some work unrelated to what we're doing`,
    `  /${COMMAND} feature/sliced/base/spike try an experiment from feature/sliced/base`,
  ].join("\n");
}

function capBytes(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let capped = value.slice(0, maxBytes);
  while (Buffer.byteLength(capped, "utf8") > maxBytes) capped = capped.slice(0, -1);
  return `${capped}\n[truncated to ${maxBytes} bytes]`;
}
