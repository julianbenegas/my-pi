import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";

const COMMAND = "btworktree";
const WORKTREE_PREFIX = "pi-btworktree";
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_DECISION_ATTEMPTS = 12;

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

interface FinalizationState {
  finalized: boolean;
  outcome?: "discarded" | "pushed";
  uncommittedStatus: string;
  commitsAheadTarget: number;
  upstream?: string;
  commitsAheadUpstream?: number;
  branchStatus: string;
  commitsAheadTargetLog: string;
  reason: string;
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
      const runResults: ExecResult[] = [];
      const initial = buildInitialPrompt(parsed.prompt, record);
      runResults.push(await runPi(record.path, record.sessionFile, initial, inherited, ctx.signal));

      let state = await getFinalizationState(record);
      for (let attempt = 1; !state.finalized; attempt++) {
        ctx.ui.setWidget(COMMAND, [
          `btworktree ${record.name}`,
          `path: ${record.path}`,
          `branch: ${record.branch}`,
          `status: awaiting commit+push or discard (${attempt})`,
          `reason: ${state.reason}`,
        ]);

        const decisionPrompt = buildDecisionPrompt(record, state, attempt);
        runResults.push(await runPi(record.path, record.sessionFile, decisionPrompt, inherited, ctx.signal));
        state = await getFinalizationState(record);

        if (!state.finalized && attempt >= MAX_DECISION_ATTEMPTS) {
          const forceDiscardPrompt = buildForceDiscardPrompt(record, state);
          runResults.push(await runPi(record.path, record.sessionFile, forceDiscardPrompt, inherited, ctx.signal));
          state = await getFinalizationState(record);
          if (!state.finalized) {
            await forceDiscardLocally(record);
            state = await getFinalizationState(record);
          }
        }
      }

      ctx.ui.setWidget(COMMAND, [`btworktree ${record.name}`, `status: ${state.reason}; deleting worktree`]);
      await removeWorktree(record);

      ctx.ui.notify(formatDoneNotification(record, state, runResults), "info");
      ctx.ui.setStatus(COMMAND, undefined);
      ctx.ui.setWidget(COMMAND, undefined);
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
  const tools = new Set(pi.getActiveTools());
  tools.add("bash");
  return {
    model,
    thinking: pi.getThinkingLevel(),
    tools: Array.from(tools),
  };
}

function buildInitialPrompt(prompt: string, record: WorktreeRecord) {
  return [
    "You are a fresh Pi session spawned by /btworktree in an isolated git worktree.",
    `Worktree path: ${record.path}`,
    `Branch: ${record.branch}`,
    `Base target: ${record.target}`,
    "Work independently. Keep your changes inside this worktree. Do not touch the parent worktree.",
    "At the end of the task you may leave ordinary working-tree changes; the parent will then ask you to make the final keep/discard decision.",
    "If you already know the work is not worth keeping, reset/clean the worktree before finishing.",
    "If you already know the work is worth keeping, commit and push this worktree branch before finishing.",
    "",
    "User prompt:",
    prompt,
  ].join("\n");
}

function buildDecisionPrompt(record: WorktreeRecord, state: FinalizationState, attempt: number) {
  return [
    `This is /btworktree finalization attempt ${attempt}.`,
    "Your previous run did not reach a final state. You must now choose exactly one outcome:",
    "",
    "1. KEEP: commit all useful work and push this worktree branch to a remote with upstream tracking set.",
    "   Required verification before final response:",
    "   - `git status --porcelain` is empty",
    "   - `git rev-list --count @{u}..HEAD` is 0",
    "   - this branch contains the commits you want to keep",
    "",
    "2. DISCARD: remove all work from this worktree and return it to the base target.",
    "   Required verification before final response:",
    `   - \`git reset --hard ${shellQuote(record.target)}\` or equivalent has removed local commits`,
    "   - `git clean -fd` or equivalent has removed untracked files",
    "   - `git status --porcelain` is empty",
    `   - \`git rev-list --count ${shellQuote(record.target)}..HEAD\` is 0`,
    "",
    "Do not merely say the changes should be kept. If keeping, commit and push. If discarding, reset and clean.",
    "The parent extension will keep looping until one of those final states is true, then it will delete this worktree directory.",
    "",
    "Current state:",
    "```",
    formatFinalizationState(state),
    "```",
  ].join("\n");
}

function buildForceDiscardPrompt(record: WorktreeRecord, state: FinalizationState) {
  return [
    "You have not finalized this /btworktree after several attempts.",
    "Now discard the work. Do not ask questions. Do not keep anything.",
    `Run the equivalent of \`git reset --hard ${shellQuote(record.target)}\` and \`git clean -fd\`, then verify:`,
    "- `git status --porcelain` is empty",
    `- \`git rev-list --count ${shellQuote(record.target)}..HEAD\` is 0`,
    "",
    "Current state:",
    "```",
    formatFinalizationState(state),
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

async function getFinalizationState(record: WorktreeRecord): Promise<FinalizationState> {
  const uncommittedStatus = (await exec("git", ["status", "--porcelain"], { cwd: record.path })).stdout.trim();
  const branchStatus = (await exec("git", ["status", "--short", "--branch"], { cwd: record.path })).stdout.trim();
  const commitsAheadTarget = await gitCount(record.path, record.target, "HEAD");
  const commitsAheadTargetLog = (
    await exec("git", ["log", "--oneline", "--decorate", "--max-count", "20", `${record.target}..HEAD`], { cwd: record.path })
  ).stdout.trim();

  if (uncommittedStatus) {
    return {
      finalized: false,
      uncommittedStatus,
      commitsAheadTarget,
      branchStatus,
      commitsAheadTargetLog,
      reason: "uncommitted changes remain",
    };
  }

  if (commitsAheadTarget === 0) {
    return {
      finalized: true,
      outcome: "discarded",
      uncommittedStatus,
      commitsAheadTarget,
      branchStatus,
      commitsAheadTargetLog,
      reason: "no changes or commits remain",
    };
  }

  const upstreamResult = await exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: record.path });
  const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : undefined;
  if (!upstream) {
    return {
      finalized: false,
      uncommittedStatus,
      commitsAheadTarget,
      branchStatus,
      commitsAheadTargetLog,
      reason: "local commits exist but no upstream is configured/pushed",
    };
  }

  const commitsAheadUpstream = await gitCount(record.path, "@{u}", "HEAD");
  if (commitsAheadUpstream > 0) {
    return {
      finalized: false,
      uncommittedStatus,
      commitsAheadTarget,
      upstream,
      commitsAheadUpstream,
      branchStatus,
      commitsAheadTargetLog,
      reason: "local commits exist but are not pushed to upstream",
    };
  }

  return {
    finalized: true,
    outcome: "pushed",
    uncommittedStatus,
    commitsAheadTarget,
    upstream,
    commitsAheadUpstream,
    branchStatus,
    commitsAheadTargetLog,
    reason: `commits pushed to ${upstream}`,
  };
}

async function gitCount(cwd: string, from: string, to: string) {
  const result = await exec("git", ["rev-list", "--count", `${from}..${to}`], { cwd });
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

function formatFinalizationState(state: FinalizationState) {
  return [
    `finalized: ${state.finalized}`,
    state.outcome ? `outcome: ${state.outcome}` : undefined,
    `reason: ${state.reason}`,
    `commitsAheadTarget: ${state.commitsAheadTarget}`,
    state.upstream ? `upstream: ${state.upstream}` : "upstream: (none)",
    state.commitsAheadUpstream !== undefined ? `commitsAheadUpstream: ${state.commitsAheadUpstream}` : undefined,
    "",
    "git status --short --branch:",
    state.branchStatus || "(empty)",
    "",
    "git status --porcelain:",
    state.uncommittedStatus || "(empty)",
    "",
    "commits ahead of target:",
    state.commitsAheadTargetLog || "(none)",
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

async function forceDiscardLocally(record: WorktreeRecord) {
  await exec("git", ["reset", "--hard", record.target], { cwd: record.path });
  await exec("git", ["clean", "-fd"], { cwd: record.path });
}

async function removeWorktree(record: WorktreeRecord) {
  await exec("git", ["worktree", "remove", "--force", record.path], { cwd: record.root });
  await rm(record.path, { recursive: true, force: true });
}

function formatDoneNotification(record: WorktreeRecord, state: FinalizationState, runResults: ExecResult[]) {
  const failedRuns = runResults
    .map((result, index) => ({ result, index: index + 1 }))
    .filter(({ result }) => result.code !== 0);

  return [
    `btworktree ${record.name}: ${state.reason}; removed ${record.path}`,
    `branch: ${record.branch}`,
    `session: ${record.sessionFile}`,
    state.outcome ? `outcome: ${state.outcome}` : undefined,
    state.upstream ? `upstream: ${state.upstream}` : undefined,
    state.commitsAheadTargetLog ? `commits:\n${state.commitsAheadTargetLog}` : undefined,
    failedRuns.length ? "" : undefined,
    ...failedRuns.map(({ result, index }) => `Child Pi run ${index} exit code: ${result.code}\n${capBytes(result.stderr, 4000)}`),
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
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

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function capBytes(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let capped = value.slice(0, maxBytes);
  while (Buffer.byteLength(capped, "utf8") > maxBytes) capped = capped.slice(0, -1);
  return `${capped}\n[truncated to ${maxBytes} bytes]`;
}
