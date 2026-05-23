import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type ExtensionAPI, getMarkdownTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CUSTOM_TYPE = "subthread";
const MAX_PARALLEL_THREADS = 8;
const MAX_CONCURRENCY = 4;
const PARENT_CONTEXT_CAP_BYTES = 40 * 1024;
const MODEL_OUTPUT_CAP_BYTES = 50 * 1024;

type ThreadStatus = "running" | "done" | "failed";

interface ThreadRecord {
  id: string;
  name?: string;
  sessionFile: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  parentSessionFile?: string;
  parentLeafId?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
}

type Message = {
  role: string;
  content?: Array<{ type: string; text?: string; name?: string; arguments?: Record<string, unknown> }> | string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
};

interface ThreadRunResult {
  thread: ThreadRecord;
  prompt: string;
  status: ThreadStatus;
  exitCode: number;
  messages: Message[];
  stderr: string;
  error?: string;
  usage: UsageStats;
  events: DisplayEvent[];
}

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

interface SubthreadDetails {
  mode: "single" | "parallel" | "list";
  results: ThreadRunResult[];
  threads: ThreadRecord[];
}

type DisplayEvent =
  | { type: "tool"; name: string; args?: Record<string, unknown>; status: "start" | "end"; isError?: boolean }
  | { type: "assistant"; text: string };

const TaskItem = Type.Object({
  threadId: Type.Optional(Type.String({ description: "Existing sub-thread id. Omit to create a new sub-thread." })),
  prompt: Type.String({ description: "Prompt or feedback to send to the sub-thread." }),
  name: Type.Optional(Type.String({ description: "Human-friendly name for a new sub-thread." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for a new sub-thread. Defaults to the parent cwd." })),
});

const SubthreadParams = Type.Object({
  action: Type.Optional(
    Type.String({
      description: 'Use "send" to start/continue threads, or "list" to list known sub-threads. Defaults to "send".',
      default: "send",
    }),
  ),
  threadId: Type.Optional(Type.String({ description: "Existing sub-thread id to continue. Omit to create a new sub-thread." })),
  prompt: Type.Optional(Type.String({ description: "Prompt or feedback to send in single-thread mode." })),
  name: Type.Optional(Type.String({ description: "Human-friendly name for a new sub-thread." })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Run multiple sub-thread prompts in parallel." })),
  includeParentContext: Type.Optional(
    Type.Boolean({
      description: "For new sub-threads, include a truncated transcript of the parent active branch in the first prompt. Default: true.",
      default: true,
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for a new single sub-thread. Defaults to the parent cwd." })),
  model: Type.Optional(
    Type.String({ description: "Override child model. Defaults to the parent's current provider/model when available." }),
  ),
  thinking: Type.Optional(
    Type.String({ description: "Override child thinking level. Defaults to the parent's current thinking level." }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Override active tools for the child. Defaults to the parent's currently active tools.",
    }),
  ),
});

type SubthreadParams = {
  action?: "send" | "list";
  threadId?: string;
  prompt?: string;
  name?: string;
  tasks?: Array<{ threadId?: string; prompt: string; name?: string; cwd?: string }>;
  includeParentContext?: boolean;
  cwd?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
};

export default function (pi: ExtensionAPI) {
  const threads = new Map<string, ThreadRecord>();

  pi.on("session_start", (_event, ctx) => {
    threads.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
      const data = entry.data as { op?: string; thread?: ThreadRecord; threadId?: string } | undefined;
      if (!data) continue;
      if (data.op === "delete" && data.threadId) threads.delete(data.threadId);
      if (data.op === "upsert" && data.thread?.id) threads.set(data.thread.id, data.thread);
    }
  });

  pi.registerCommand("subthreads", {
    description: "List sub-thread sessions known to the current parent session",
    handler: async (_args, ctx) => {
      const list = Array.from(threads.values());
      if (list.length === 0) {
        ctx.ui.notify("No sub-threads in this parent session yet.", "info");
        return;
      }
      ctx.ui.notify(formatThreadList(list), "info");
    },
  });

  pi.registerTool({
    name: "subthread",
    label: "Sub-thread",
    description: [
      "Start or continue persistent sub-Pi sessions from the parent conversation.",
      "Use this when the user asks to delegate work to sub-pis, subagents, or sub-threads and may want to send later feedback.",
      "New sub-threads inherit the parent's cwd, model, thinking level, active tools, settings, credentials, context files, and extensions as CLI/runtime configuration.",
      "Each sub-thread has its own persisted Pi session file; call again with threadId to continue it.",
    ].join(" "),
    promptSnippet: "Start/continue persistent sub-Pi sessions and return their results to the parent.",
    promptGuidelines: [
      "Use subthread when the user asks to delegate a prompt to sub-pis/subagents/sub-threads or wants parallel independent investigation.",
      "When continuing a prior sub-thread, pass its threadId and the user's feedback as prompt.",
    ],
    parameters: SubthreadParams,

    async execute(_toolCallId, params: SubthreadParams, signal, onUpdate, ctx) {
      const action = params.action ?? "send";
      const allThreads = () => Array.from(threads.values()).sort((a, b) => a.createdAt - b.createdAt);
      const makeDetails = (mode: SubthreadDetails["mode"], results: ThreadRunResult[] = []): SubthreadDetails => ({
        mode,
        results,
        threads: allThreads(),
      });

      if (action === "list") {
        const list = allThreads();
        return {
          content: [{ type: "text", text: formatThreadList(list) }],
          details: makeDetails("list"),
        };
      }

      const tasks = params.tasks?.length
        ? params.tasks
        : params.prompt
          ? [{ threadId: params.threadId, prompt: params.prompt, name: params.name, cwd: params.cwd }]
          : [];

      if (tasks.length === 0) {
        return {
          content: [{ type: "text", text: `No prompt provided.\n\n${formatThreadList(allThreads())}` }],
          details: makeDetails("list"),
        };
      }

      if (tasks.length > MAX_PARALLEL_THREADS) {
        return {
          content: [{ type: "text", text: `Too many parallel sub-threads (${tasks.length}). Max is ${MAX_PARALLEL_THREADS}.` }],
          details: makeDetails("parallel"),
        };
      }

      const inherited = getInheritedOptions(pi, ctx, params);
      const includeParentContext = params.includeParentContext ?? true;
      const parentContext = includeParentContext ? buildParentContext(ctx) : undefined;
      const parentSessionFile = ctx.sessionManager.getSessionFile();
      const parentLeafId = ctx.sessionManager.getLeafId() ?? undefined;
      const mode: "single" | "parallel" = tasks.length === 1 ? "single" : "parallel";

      const placeholders: ThreadRunResult[] = tasks.map((task) => {
        const existing = task.threadId ? threads.get(task.threadId) : undefined;
        const thread = existing ?? makePendingThread(ctx.cwd, task.cwd, task.name, parentSessionFile, parentLeafId, inherited);
        return makePlaceholderResult(thread, task.prompt);
      });

      const emit = () => {
        onUpdate?.({
          content: [{ type: "text", text: formatModelVisibleResults(placeholders, true) }],
          details: makeDetails(mode, placeholders),
        });
      };
      emit();

      const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (task, index) => {
        const existing = task.threadId ? threads.get(task.threadId) : undefined;
        if (task.threadId && !existing) {
          const result = makeFailedResult(placeholders[index].thread, task.prompt, `Unknown sub-thread id: ${task.threadId}`);
          placeholders[index] = result;
          emit();
          return result;
        }

        const thread = existing ?? createThread(ctx.cwd, task.cwd, task.name, parentSessionFile, parentLeafId, inherited);
        if (!existing) persistThread(pi, threads, thread);

        placeholders[index] = makePlaceholderResult(thread, task.prompt);
        emit();

        const prompt = existing
          ? buildFollowUpPrompt(task.prompt)
          : buildInitialPrompt({ delegatedPrompt: task.prompt, parentContext, parentSessionFile, parentLeafId });

        const result = await runChildPi(thread, prompt, signal, (partial) => {
          placeholders[index] = partial;
          emit();
        });

        thread.updatedAt = Date.now();
        persistThread(pi, threads, thread);
        placeholders[index] = result;
        emit();
        return result;
      });

      return {
        content: [{ type: "text", text: formatModelVisibleResults(results, false) }],
        details: makeDetails(mode, results),
      };
    },

    renderCall(args, theme) {
      if (args.action === "list") return new Text(theme.fg("toolTitle", theme.bold("subthread list")), 0, 0);
      if (args.tasks?.length) {
        let text = theme.fg("toolTitle", theme.bold("subthread ")) + theme.fg("accent", `parallel (${args.tasks.length})`);
        for (const task of args.tasks.slice(0, 4)) {
          const label = task.threadId ?? task.name ?? "new";
          text += `\n  ${theme.fg("accent", label)} ${theme.fg("dim", truncateChars(task.prompt, 70))}`;
        }
        if (args.tasks.length > 4) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 4} more`)}`;
        return new Text(text, 0, 0);
      }
      const label = args.threadId ?? args.name ?? "new";
      return new Text(
        theme.fg("toolTitle", theme.bold("subthread ")) +
          theme.fg("accent", label) +
          `\n  ${theme.fg("dim", truncateChars(args.prompt ?? "", 100))}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubthreadDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }

      if (details.mode === "list") return new Text(formatThreadList(details.threads), 0, 0);

      const container = new Container();
      const done = details.results.filter((r) => r.status !== "running").length;
      const failed = details.results.filter((r) => r.status === "failed").length;
      const running = details.results.length - done;
      const icon = running > 0 ? theme.fg("warning", "⏳") : failed > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
      container.addChild(
        new Text(
          `${icon} ${theme.fg("toolTitle", theme.bold("subthread "))}${theme.fg("accent", `${done}/${details.results.length}`)}${running ? theme.fg("muted", ` (${running} running)`) : ""}`,
          0,
          0,
        ),
      );

      for (const run of details.results) {
        container.addChild(new Spacer(1));
        const runIcon = run.status === "running" ? theme.fg("warning", "⏳") : run.status === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const name = run.thread.name ? `${run.thread.name} ` : "";
        container.addChild(
          new Text(
            `${runIcon} ${theme.fg("accent", `${name}${run.thread.id}`)} ${theme.fg("muted", shortSession(run.thread.sessionFile))}`,
            0,
            0,
          ),
        );

        if (expanded) {
          container.addChild(new Text(theme.fg("muted", "Prompt: ") + theme.fg("dim", run.prompt), 0, 0));
          for (const event of run.events) {
            if (event.type === "tool") {
              container.addChild(new Text(theme.fg("muted", `→ ${event.name}`) + theme.fg("dim", ` ${formatArgs(event.args)}`), 0, 0));
            }
          }
        }

        if (run.error) {
          container.addChild(new Text(theme.fg("error", run.error), 0, 0));
        } else {
          const output = getFinalOutput(run.messages) || (run.status === "running" ? "(running...)" : "(no output)");
          if (expanded && output !== "(running...)" && output !== "(no output)") {
            container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
          } else {
            container.addChild(new Text(theme.fg("toolOutput", truncateChars(output.replace(/\n+/g, " "), 300)), 0, 0));
          }
        }

        const usage = formatUsage(run.usage, run.thread.model);
        if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
      }

      if (!expanded && details.results.some((r) => r.events.length > 0 || getFinalOutput(r.messages).length > 300)) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "Ctrl+O to expand"), 0, 0));
      }

      return container;
    },
  });
}

function getInheritedOptions(pi: ExtensionAPI, ctx: { model?: { provider: string; id: string } }, params: { model?: string; thinking?: string; tools?: string[] }) {
  const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  return {
    model: params.model ?? parentModel,
    thinking: params.thinking ?? pi.getThinkingLevel(),
    tools: params.tools ?? pi.getActiveTools(),
  };
}

function makePendingThread(
  parentCwd: string,
  cwd: string | undefined,
  name: string | undefined,
  parentSessionFile: string | undefined,
  parentLeafId: string | undefined,
  inherited: { model?: string; thinking?: string; tools?: string[] },
): ThreadRecord {
  const now = Date.now();
  return {
    id: createThreadId(),
    name,
    sessionFile: "(pending)",
    cwd: cwd ?? parentCwd,
    createdAt: now,
    updatedAt: now,
    parentSessionFile,
    parentLeafId,
    ...inherited,
  };
}

function createThread(
  parentCwd: string,
  cwd: string | undefined,
  name: string | undefined,
  parentSessionFile: string | undefined,
  parentLeafId: string | undefined,
  inherited: { model?: string; thinking?: string; tools?: string[] },
): ThreadRecord {
  const childCwd = cwd ?? parentCwd;
  const sm = SessionManager.create(childCwd);
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) throw new Error("Failed to create persisted sub-thread session");
  const now = Date.now();
  return {
    id: createThreadId(),
    name,
    sessionFile,
    cwd: childCwd,
    createdAt: now,
    updatedAt: now,
    parentSessionFile,
    parentLeafId,
    ...inherited,
  };
}

function persistThread(pi: ExtensionAPI, threads: Map<string, ThreadRecord>, thread: ThreadRecord) {
  threads.set(thread.id, { ...thread });
  pi.appendEntry(CUSTOM_TYPE, { op: "upsert", thread: { ...thread } });
}

function createThreadId() {
  return `st-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function makePlaceholderResult(thread: ThreadRecord, prompt: string): ThreadRunResult {
  return {
    thread,
    prompt,
    status: "running",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    events: [],
  };
}

function makeFailedResult(thread: ThreadRecord, prompt: string, error: string): ThreadRunResult {
  return {
    thread,
    prompt,
    status: "failed",
    exitCode: 1,
    messages: [],
    stderr: "",
    error,
    usage: emptyUsage(),
    events: [],
  };
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function buildInitialPrompt(options: {
  delegatedPrompt: string;
  parentContext?: string;
  parentSessionFile?: string;
  parentLeafId?: string;
}) {
  const parts = [
    "You are a sub-Pi running in a persistent sub-thread spawned by a parent Pi session.",
    "Work independently. The parent may send follow-up feedback later in this same sub-thread session.",
    "Return a concise, useful result for the parent. If you change files, summarize exactly what changed and how you validated it.",
  ];

  if (options.parentSessionFile || options.parentLeafId) {
    parts.push(
      [
        "Parent linkage:",
        options.parentSessionFile ? `- parentSessionFile: ${options.parentSessionFile}` : undefined,
        options.parentLeafId ? `- parentLeafId: ${options.parentLeafId}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (options.parentContext) parts.push(`Parent active-branch context, truncated if necessary:\n\n${options.parentContext}`);
  parts.push(`Delegated prompt:\n\n${options.delegatedPrompt}`);
  return parts.join("\n\n---\n\n");
}

function buildFollowUpPrompt(prompt: string) {
  return `Parent follow-up for this sub-thread:\n\n${prompt}`;
}

async function runChildPi(
  thread: ThreadRecord,
  prompt: string,
  signal: AbortSignal | undefined,
  onPartial: (result: ThreadRunResult) => void,
): Promise<ThreadRunResult> {
  const args = ["--mode", "json", "-p", "--session", thread.sessionFile];
  if (thread.model) args.push("--model", thread.model);
  if (thread.thinking) args.push("--thinking", thread.thinking);
  if (thread.tools?.length) args.push("--tools", thread.tools.join(","));
  args.push(prompt);

  const result = makePlaceholderResult(thread, prompt);
  let buffer = "";
  let wasAborted = false;

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: thread.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "tool_execution_start") {
        result.events.push({ type: "tool", name: event.toolName, args: event.args, status: "start" });
        onPartial({ ...result, events: [...result.events], messages: [...result.messages] });
      }

      if (event.type === "tool_execution_end") {
        result.events.push({ type: "tool", name: event.toolName, status: "end", isError: event.isError });
        onPartial({ ...result, events: [...result.events], messages: [...result.messages] });
      }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        result.messages.push(msg);
        if (msg.role === "assistant") {
          result.usage.turns++;
          const usage = msg.usage;
          if (usage) {
            result.usage.input += usage.input || 0;
            result.usage.output += usage.output || 0;
            result.usage.cacheRead += usage.cacheRead || 0;
            result.usage.cacheWrite += usage.cacheWrite || 0;
            result.usage.cost += usage.cost?.total || 0;
          }
          const text = firstText(msg);
          if (text) result.events.push({ type: "assistant", text });
        }
        onPartial({ ...result, events: [...result.events], messages: [...result.messages], usage: { ...result.usage } });
      }
    };

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      result.stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      resolve(code ?? 0);
    });

    proc.on("error", (error) => {
      result.error = error.message;
      resolve(1);
    });

    const killProc = () => {
      wasAborted = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000).unref();
    };

    if (signal?.aborted) killProc();
    else signal?.addEventListener("abort", killProc, { once: true });
  });

  result.exitCode = exitCode;
  result.status = exitCode === 0 && !wasAborted ? "done" : "failed";
  if (wasAborted) result.error = "Sub-thread was aborted";
  if (!result.error && exitCode !== 0) result.error = result.stderr || `Sub-thread exited with code ${exitCode}`;
  return result;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript) return { command: process.execPath, args: [currentScript, ...args] };
  return { command: "pi", args };
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildParentContext(ctx: { sessionManager: { getBranch(): any[] } }) {
  const lines: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message") lines.push(formatMessage(entry.message));
    else if (entry.type === "branch_summary") lines.push(`[branch summary]\n${entry.summary}`);
    else if (entry.type === "compaction") lines.push(`[compaction summary]\n${entry.summary}`);
  }
  return capBytes(lines.filter(Boolean).join("\n\n"), PARENT_CONTEXT_CAP_BYTES);
}

function formatMessage(message: any) {
  switch (message.role) {
    case "user":
      return `[user]\n${contentToText(message.content)}`;
    case "assistant":
      return `[assistant]\n${contentToText(message.content)}`;
    case "toolResult":
      return `[tool result: ${message.toolName}]\n${contentToText(message.content)}`;
    case "custom":
      return message.display ? `[custom: ${message.customType}]\n${contentToText(message.content)}` : "";
    default:
      return "";
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part?.type === "text") return part.text;
      if (part?.type === "thinking") return `[thinking omitted]`;
      if (part?.type === "toolCall") return `[tool call: ${part.name} ${JSON.stringify(part.arguments ?? {})}]`;
      if (part?.type === "image") return `[image]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function firstText(message: Message): string {
  if (message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  for (const part of message.content) {
    if (part.type === "text") return part.text ?? "";
  }
  return "";
}

function getFinalOutput(messages: Message[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const text = firstText(msg);
      if (text) return text;
    }
  }
  return "";
}

function formatModelVisibleResults(results: ThreadRunResult[], partial: boolean) {
  return results
    .map((result) => {
      const header = `### ${result.thread.name ? `${result.thread.name} ` : ""}${result.thread.id} (${result.status})`;
      const session = `Session: ${result.thread.sessionFile}`;
      const output = result.error || getFinalOutput(result.messages) || (partial ? "(running...)" : "(no output)");
      return `${header}\n${session}\n\n${capBytes(output, MODEL_OUTPUT_CAP_BYTES)}`;
    })
    .join("\n\n---\n\n");
}

function formatThreadList(threads: ThreadRecord[]) {
  if (threads.length === 0) return "No sub-threads.";
  return threads
    .map((thread) => {
      const name = thread.name ? `${thread.name} ` : "";
      const updated = new Date(thread.updatedAt).toLocaleString();
      return `- ${name}${thread.id}\n  session: ${thread.sessionFile}\n  cwd: ${thread.cwd}\n  updated: ${updated}`;
    })
    .join("\n");
}

function formatUsage(usage: UsageStats, model?: string) {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input) parts.push(`↑${formatNumber(usage.input)}`);
  if (usage.output) parts.push(`↓${formatNumber(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatNumber(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatNumber(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatNumber(value: number) {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

function shortSession(sessionFile: string) {
  const index = sessionFile.lastIndexOf("/");
  return index >= 0 ? sessionFile.slice(index + 1) : sessionFile;
}

function formatArgs(args: Record<string, unknown> | undefined) {
  if (!args) return "";
  const json = JSON.stringify(args);
  return truncateChars(json, 120);
}

function truncateChars(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function capBytes(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let capped = value.slice(0, maxBytes);
  while (Buffer.byteLength(capped, "utf8") > maxBytes) capped = capped.slice(0, -1);
  return `${capped}\n\n[truncated to ${maxBytes} bytes]`;
}
