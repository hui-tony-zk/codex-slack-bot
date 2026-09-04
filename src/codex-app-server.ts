import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { writeLog } from "./logger.js";

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string };

export type AppServerThreadItem = {
  type: string;
  id: string;
  text?: string;
  command?: string;
  changes?: Array<{ path: string; kind: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  query?: string;
  status?: string;
  [key: string]: unknown;
};

export type CodexTurnCallbacks = {
  onItemStarted(item: AppServerThreadItem): void;
  onItemCompleted(item: AppServerThreadItem): void;
};

type RpcResponse = { id: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
type RpcNotification = { method: string; params?: Record<string, any> };
type PendingRequest = { resolve(value: any): void; reject(error: Error): void };

function codexCommand(): { command: string; args: string[] } {
  const override = process.env.CODEX_PATH?.trim();
  if (override) return { command: override, args: ["app-server", "--stdio"] };

  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("@openai/codex/package.json");
  return {
    command: process.execPath,
    args: [join(dirname(packageJson), "bin", "codex.js"), "app-server", "--stdio"],
  };
}

export class CodexAppServerClient {
  private process: ReturnType<typeof spawn> | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Set<(notification: RpcNotification) => void>();
  private starting: Promise<void> | null = null;

  async start(): Promise<void> {
    if (this.process) return;
    if (this.starting) return this.starting;
    this.starting = this.startProcess();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startProcess(): Promise<void> {
    const { command, args } = codexCommand();
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.process = child;

    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      writeLog("error", { scope: "codex-app-server", message: "Codex app-server stderr", line });
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      this.process = null;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      for (const listener of this.listeners) {
        listener({ method: "transport/closed", params: { error: error.message } });
      }
      this.listeners.clear();
      writeLog("error", {
        scope: "codex-app-server",
        message: "Codex app-server process exited",
        code,
        signal,
      });
    });

    await this.request("initialize", {
      clientInfo: { name: "codex-slack-bot", title: "Codex Slack Agent", version: "1.0.0" },
      capabilities: null,
    });
    this.notify("initialized");
    writeLog("info", { scope: "codex-app-server", message: "Codex app-server initialized" });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: RpcResponse | RpcNotification;
    try {
      message = JSON.parse(line);
    } catch (error) {
      writeLog("error", {
        scope: "codex-app-server",
        message: "Could not parse Codex app-server output",
        line,
        error: (error as Error).message,
      });
      return;
    }

    if ("id" in message) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || "Codex app-server request failed");
        Object.assign(error, { code: message.error.code, data: message.error.data });
        request.reject(error);
      } else {
        request.resolve(message.result);
      }
      return;
    }

    for (const listener of this.listeners) listener(message);
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const child = this.process;
    if (!child?.stdin.writable) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string): void {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server is not running");
    this.process.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  async openThread(args: {
    existingThreadId?: string;
    cwd: string;
    approvalPolicy: string;
    sandbox: string;
  }): Promise<string> {
    await this.start();
    const params = {
      cwd: args.cwd,
      approvalPolicy: args.approvalPolicy,
      sandbox: args.sandbox,
    };
    const response = args.existingThreadId
      ? await this.request<any>("thread/resume", { threadId: args.existingThreadId, ...params })
      : await this.request<any>("thread/start", params);
    return response.thread.id;
  }

  async startTurn(threadId: string, input: CodexUserInput[], callbacks: CodexTurnCallbacks): Promise<{
    turnId: string;
    result: Promise<string>;
  }> {
    await this.start();
    let turnId = "";
    let resultText = "";
    let resolveResult!: (value: string) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const listener = (notification: RpcNotification) => {
      const params = notification.params || {};
      if (params.threadId !== threadId || (turnId && params.turnId && params.turnId !== turnId)) return;
      if (notification.method === "item/started") callbacks.onItemStarted(params.item);
      if (notification.method === "item/completed") {
        callbacks.onItemCompleted(params.item);
        if (params.item?.type === "agentMessage" && params.item.text) resultText = params.item.text;
      }
      if (notification.method === "error") {
        writeLog("error", {
          scope: "codex-app-server-turn",
          message: "Codex turn error notification",
          threadId,
          turnId: params.turnId || turnId,
          willRetry: params.willRetry,
          error: params.error,
        });
      }
      if (notification.method === "transport/closed") {
        this.listeners.delete(listener);
        rejectResult(new Error(String(params.error || "Codex app-server connection closed")));
      }
      if (notification.method === "turn/completed" && params.turn?.id === turnId) {
        this.listeners.delete(listener);
        if (params.turn.status === "failed") {
          rejectResult(new Error(params.turn.error?.message || "Codex turn failed"));
        } else {
          resolveResult(resultText);
        }
      }
    };
    this.listeners.add(listener);
    try {
      const response = await this.request<any>("turn/start", { threadId, input });
      turnId = response.turn.id;
      return { turnId, result };
    } catch (error) {
      this.listeners.delete(listener);
      rejectResult(error as Error);
      throw error;
    }
  }

  async steerTurn(threadId: string, expectedTurnId: string, input: CodexUserInput[]): Promise<void> {
    await this.start();
    await this.request("turn/steer", { threadId, expectedTurnId, input });
  }
}

export const codexAppServer = new CodexAppServerClient();
