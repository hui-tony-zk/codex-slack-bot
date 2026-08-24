import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalMode, ModelReasoningEffort, SandboxMode, ThreadItem } from "@openai/codex-sdk";
import { codexAppServer } from "./codex-app-server.js";
import type { AppServerThreadItem, CodexUserInput } from "./codex-app-server.js";
import { CLAUDE_MODEL, CODEX_MODEL_REASONING_EFFORT, DEFAULT_MODEL, MAX_TURNS } from "./config.js";
import { formatToolDetail } from "./formatting.js";
import { logThread, serializeError, writeLog } from "./logger.js";
import { SYSTEM_PROMPT } from "./prompt.js";

export type AgentProvider = "codex" | "claude";

export type BuiltPrompt = {
  text: string;
  imagePaths: string[];
  audioPaths: string[];
};

export type ToolTrace = { id: string; name: string; detail: string };

type RunAgentArgs = {
  prompt: BuiltPrompt;
  cwd: string;
  existingSessionId: string | undefined;
  threadTs: string;
  onSession: (sessionId: string) => void;
  onTool: (
    tool: ToolTrace | null,
    completedTool?: ToolTrace,
    completedStatus?: "complete" | "error",
  ) => void;
  onAgentMessage?: (id: string, text: string) => void;
};

const CODEX_SESSION_PREFIX = "codex:";
const CLAUDE_SESSION_PREFIX = "claude:";
const VALID_SANDBOX_MODES = new Set<SandboxMode>(["read-only", "workspace-write", "danger-full-access"]);
const VALID_APPROVAL_MODES = new Set<ApprovalMode>(["never", "on-request", "on-failure", "untrusted"]);
const VALID_REASONING_EFFORTS = new Set<ModelReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);
const MAX_CODEX_ATTEMPTS = 2;
const CODEX_RETRY_DELAY_MS = 1_000;
const RETRYABLE_CODEX_DISCONNECT = /stream disconnected before completion|websocket closed by server before response\.completed/i;

export function shouldRetryCodexTurn(error: unknown, attempt: number, sideEffectEventCount: number): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return attempt < MAX_CODEX_ATTEMPTS
    && sideEffectEventCount === 0
    && RETRYABLE_CODEX_DISCONNECT.test(message);
}

function isPotentiallySideEffectingItem(item: ThreadItem): boolean {
  return item.type === "command_execution"
    || item.type === "file_change"
    || item.type === "mcp_tool_call";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function encodeSessionId(provider: AgentProvider, sessionId: string): string {
  return `${provider === "codex" ? CODEX_SESSION_PREFIX : CLAUDE_SESSION_PREFIX}${sessionId}`;
}

export function decodeSessionId(provider: AgentProvider, storedSessionId: string | undefined): string | undefined {
  if (!storedSessionId) return undefined;
  const prefix = provider === "codex" ? CODEX_SESSION_PREFIX : CLAUDE_SESSION_PREFIX;
  if (storedSessionId.startsWith(prefix)) return storedSessionId.slice(prefix.length);
  return provider === "claude" && !storedSessionId.startsWith(CODEX_SESSION_PREFIX) ? storedSessionId : undefined;
}

export function getProviderModel(provider: AgentProvider): string | undefined {
  if (provider === "codex") return DEFAULT_MODEL;
  return CLAUDE_MODEL || undefined;
}

export async function runAgentQuery(provider: AgentProvider, args: RunAgentArgs): Promise<string> {
  return provider === "codex" ? runCodexQuery(args) : runClaudeQuery(args);
}

export async function createTopLevelCodexTask(args: {
  cwd: string;
  prompt: string;
  sourceThreadTs: string;
}): Promise<{ threadId: string; turnId: string }> {
  const threadId = await codexAppServer.openThread({
    model: DEFAULT_MODEL,
    cwd: args.cwd,
    sandbox: getSandboxMode(),
    approvalPolicy: getApprovalPolicy(),
    effort: getModelReasoningEffort(),
  });
  const turn = await codexAppServer.startTurn(
    threadId,
    buildCodexUserInput({ text: args.prompt, imagePaths: [], audioPaths: [] }, true),
    {
      onItemStarted() {},
      onItemCompleted() {},
    },
  );

  logThread(args.sourceThreadTs, "Created top-level Codex task", {
    createdThreadId: threadId,
    createdTurnId: turn.turnId,
    cwd: args.cwd,
  });
  void turn.result.then(
    (resultText) => logThread(args.sourceThreadTs, "Top-level Codex task completed", {
      createdThreadId: threadId,
      createdTurnId: turn.turnId,
      resultChars: resultText.length,
    }),
    (error) => writeLog("error", {
      scope: "top-level-codex-task",
      threadTs: args.sourceThreadTs,
      message: "Top-level Codex task failed",
      createdThreadId: threadId,
      createdTurnId: turn.turnId,
      error: serializeError(error),
    }),
  );

  return { threadId, turnId: turn.turnId };
}

type ActiveCodexTurn = { threadId: string; turnId: string };
const activeCodexTurns = new Map<string, ActiveCodexTurn>();

export async function steerAgentQuery(threadTs: string, prompt: BuiltPrompt): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const active = activeCodexTurns.get(threadTs);
    if (active) {
      await codexAppServer.steerTurn(active.threadId, active.turnId, buildCodexUserInput(prompt, false));
      logThread(threadTs, "Steered active Codex turn", {
        sessionId: active.threadId,
        turnId: active.turnId,
        imageCount: prompt.imagePaths.length,
        downloadedAudioCount: prompt.audioPaths.length,
      });
      return true;
    }
    await sleep(100);
  }
  return false;
}

function buildClaudeEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_") && typeof value === "string"
    )
  ) as Record<string, string>;
}

function getSandboxMode(): SandboxMode {
  const mode = process.env.CODEX_SANDBOX_MODE as SandboxMode | undefined;
  return mode && VALID_SANDBOX_MODES.has(mode) ? mode : "danger-full-access";
}

function getApprovalPolicy(): ApprovalMode {
  const policy = process.env.CODEX_APPROVAL_POLICY as ApprovalMode | undefined;
  return policy && VALID_APPROVAL_MODES.has(policy) ? policy : "never";
}

function getModelReasoningEffort(): ModelReasoningEffort | undefined {
  const effort = CODEX_MODEL_REASONING_EFFORT as ModelReasoningEffort | undefined;
  return effort && VALID_REASONING_EFFORTS.has(effort) ? effort : undefined;
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/^mcp__/, "")
    .replace(/[_:-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function humanizeCommand(command: string): string {
  const normalized = command.toLowerCase();
  if (normalized.includes("ffprobe")) return "Inspecting the video";
  if (normalized.includes("ffmpeg")) return "Preparing the video";
  if (/\b(vitest|jest|pytest|npm test|pnpm test|npm run typecheck)\b/.test(normalized)) return "Checking the result";
  if (/\bgit\s+(diff|status|show)\b/.test(normalized)) return "Reviewing changes";
  if (normalized.includes("/downloads") && /\bfind\b/.test(normalized)) return "Finding downloaded media";
  if (/\b(rg|grep)\b/.test(normalized)) return "Searching local files";
  if (/\b(find|fd)\b/.test(normalized)) return "Finding local files";
  if (/\b(sed|cat|head|tail)\b/.test(normalized)) return "Reading local files";
  return "Running a local tool";
}

function humanizeMcpTool(server: string, tool: string, rawArguments: unknown): ToolTrace["name"] {
  const args = rawArguments && typeof rawArguments === "object"
    ? rawArguments as Record<string, unknown>
    : {};
  if (typeof args.title === "string" && args.title.trim()) return args.title.trim();

  const key = `${server}:${tool}`.toLowerCase();
  if (key.includes("node_repl") || key.includes("browser") || key.includes("chrome")) return "Using the browser";
  if (key.includes("video_watch") || key.includes("video_understanding")) return "Understanding the video";
  if (key.includes("process_video")) return "Analyzing the video";
  if (key.includes("web") && key.includes("search")) return "Searching the web";
  return humanizeIdentifier(tool) || "Using a connected tool";
}

function codexItemToTool(item: ThreadItem): ToolTrace | null {
  switch (item.type) {
    case "command_execution":
      return { id: item.id, name: humanizeCommand(item.command), detail: "" };
    case "file_change": {
      const paths = item.changes.map((change) => change.path.split("/").pop() || change.path);
      const singleChange = item.changes.length === 1 ? item.changes[0] : null;
      const verb = singleChange?.kind === "add" ? "Creating" : singleChange?.kind === "delete" ? "Removing" : "Updating";
      return {
        id: item.id,
        name: singleChange ? `${verb} ${paths[0]}` : `Updating ${item.changes.length} files`,
        detail: singleChange ? "" : paths.slice(0, 3).join(", "),
      };
    }
    case "mcp_tool_call": {
      const args = item.arguments && typeof item.arguments === "object"
        ? item.arguments as Record<string, unknown>
        : {};
      const hasTitle = typeof args.title === "string" && args.title.trim().length > 0;
      return {
        id: item.id,
        name: humanizeMcpTool(item.server, item.tool, item.arguments),
        detail: hasTitle ? "" : formatToolDetail(item.tool, args),
      };
    }
    case "web_search":
      return { id: item.id, name: "Searching the web", detail: item.query };
    case "todo_list": {
      const completed = item.items.filter((todo) => todo.completed).length;
      const current = item.items.find((todo) => !todo.completed);
      return {
        id: item.id,
        name: current?.text || "Plan complete",
        detail: `${completed}/${item.items.length} steps complete`,
      };
    }
    default:
      return null;
  }
}

function completedToolStatus(item: ThreadItem): "complete" | "error" {
  if (item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call") {
    return item.status === "failed" ? "error" : "complete";
  }
  return "complete";
}

function buildCodexUserInput(prompt: BuiltPrompt, includeSystemPrompt: boolean): CodexUserInput[] {
  const text = includeSystemPrompt ? `${SYSTEM_PROMPT}\n\n---\n\n${prompt.text}` : prompt.text;
  return [
    { type: "text", text, text_elements: [] },
    ...prompt.imagePaths.map((path) => ({ type: "localImage" as const, path })),
  ];
}

function appServerItemToTool(item: AppServerThreadItem): ToolTrace | null {
  switch (item.type) {
    case "commandExecution":
      return { id: item.id, name: humanizeCommand(item.command || ""), detail: "" };
    case "fileChange": {
      const changes = item.changes || [];
      const paths = changes.map((change) => change.path.split("/").pop() || change.path);
      const singleChange = changes.length === 1 ? changes[0] : null;
      const verb = singleChange?.kind === "add" ? "Creating" : singleChange?.kind === "delete" ? "Removing" : "Updating";
      return {
        id: item.id,
        name: singleChange ? `${verb} ${paths[0]}` : `Updating ${changes.length} files`,
        detail: singleChange ? "" : paths.slice(0, 3).join(", "),
      };
    }
    case "mcpToolCall": {
      const rawArguments = item.arguments && typeof item.arguments === "object" ? item.arguments : {};
      const args = rawArguments as Record<string, unknown>;
      const hasTitle = typeof args.title === "string" && args.title.trim().length > 0;
      return {
        id: item.id,
        name: humanizeMcpTool(item.server || "", item.tool || "", rawArguments),
        detail: hasTitle ? "" : formatToolDetail(item.tool || "", args),
      };
    }
    case "webSearch":
      return { id: item.id, name: "Searching the web", detail: item.query || "" };
    default:
      return null;
  }
}

function appServerCompletedStatus(item: AppServerThreadItem): "complete" | "error" {
  return item.status === "failed" ? "error" : "complete";
}

async function runCodexQuery(args: RunAgentArgs): Promise<string> {
  const threadOptions = {
    model: DEFAULT_MODEL,
    cwd: args.cwd,
    sandbox: getSandboxMode(),
    approvalPolicy: getApprovalPolicy(),
    effort: getModelReasoningEffort(),
  };
  const sessionId = await codexAppServer.openThread({
    existingThreadId: args.existingSessionId,
    ...threadOptions,
  });
  args.onSession(sessionId);
  logThread(args.threadTs, "Codex session initialized", { sessionId, runtime: "app-server" });

  const runningTools = new Map<string, ToolTrace>();
  const turn = await codexAppServer.startTurn(
    sessionId,
    buildCodexUserInput(args.prompt, true),
    {
      onItemStarted(item) {
        const tool = appServerItemToTool(item);
        if (!tool) return;
        runningTools.set(item.id, tool);
        args.onTool(tool);
      },
      onItemCompleted(item) {
        if (item.type === "agentMessage" && item.text?.trim()) {
          args.onAgentMessage?.(item.id, item.text.trim());
        }
        const tool = appServerItemToTool(item);
        if (!tool) return;
        runningTools.delete(item.id);
        args.onTool(Array.from(runningTools.values()).at(-1) || null, tool, appServerCompletedStatus(item));
      },
    },
  );
  activeCodexTurns.set(args.threadTs, { threadId: sessionId, turnId: turn.turnId });
  logThread(args.threadTs, "Codex turn started", { sessionId, turnId: turn.turnId });
  try {
    return await turn.result;
  } finally {
    activeCodexTurns.delete(args.threadTs);
  }
}

async function runClaudeQuery(args: RunAgentArgs): Promise<string> {
  let resultText = "";
  const options: Record<string, unknown> = {
    cwd: args.cwd,
    env: buildClaudeEnv(),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: SYSTEM_PROMPT,
    },
    maxTurns: MAX_TURNS,
    permissionMode: "bypassPermissions",
    stderr: (data: string) => {
      writeLog("error", {
        scope: "claude-stderr",
        threadTs: args.threadTs,
        message: "Claude subprocess stderr",
        data,
      });
    },
  };

  if (CLAUDE_MODEL) options.model = CLAUDE_MODEL;
  if (args.existingSessionId) options.resume = args.existingSessionId;

  for await (const message of query({ prompt: args.prompt.text, options })) {
    if (message.type === "system" && message.subtype === "init") {
      args.onSession(message.session_id);
      logThread(args.threadTs, "Claude session initialized", { sessionId: message.session_id });
    }

    if (message.type === "assistant") {
      const content = message.message?.content || [];
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        args.onTool({
          id: block.id,
          name: block.name,
          detail: formatToolDetail(block.name, block.input as Record<string, unknown>),
        });
      }
    }

    if (message.type === "result" && message.subtype === "success") resultText = message.result || "";
    if (message.type === "result" && message.subtype !== "success") {
      const errorMessage = (message as any).error || (message as any).message || "Unknown error";
      throw new Error(errorMessage);
    }
  }

  return resultText;
}
