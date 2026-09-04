import "dotenv/config";
import bolt from "@slack/bolt";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AGENT_PROVIDER, CLAUDE_MODEL, DEFAULT_CWD, PATHS } from "./config.js";
import { createMessageHandler } from "./handler.js";
import { removeLegacyRuntimeLog, writeLog } from "./logger.js";
import { createStateStore } from "./state.js";

const { App } = bolt;
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const state = createStateStore();
const handleMessage = createMessageHandler(app as any, state);

app.event("app_mention", (args: any) => {
  writeLog("info", {
    scope: "event",
    threadTs: args.event.thread_ts || args.event.ts,
    message: "Received app_mention event",
    user: args.event.user,
  });
  return handleMessage(args);
});

app.event("message", async (args: any) => {
  const { event } = args;
  writeLog("info", {
    scope: "event",
    threadTs: event.thread_ts || event.ts,
    message: "Received message event",
    channelType: event.channel_type,
    botId: event.bot_id || null,
    subtype: event.subtype || null,
  });
  if (event.channel_type !== "im" || event.bot_id) return;
  if (event.subtype && event.subtype !== "file_share") return;
  await handleMessage(args);
});

process.on("exit", () => state.releaseProcessLock());
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

process.on("unhandledRejection", (err) => {
  writeLog("error", {
    scope: "process",
    message: "Unhandled rejection",
    error: (err as Error)?.message || String(err),
    stack: (err as Error)?.stack || null,
  });
});

process.on("uncaughtException", (err) => {
  writeLog("error", {
    scope: "process",
    message: "Uncaught exception — exiting with code 1 for crash recovery",
    error: err.message,
    stack: err.stack || null,
  });
  process.exit(1);
});

async function notifyRestart(): Promise<void> {
  const restartOriginPath = join(PATHS.DATA_DIR, "restart-origin.json");
  try {
    const raw = readFileSync(restartOriginPath, "utf-8");
    const { channel, threadTs } = JSON.parse(raw);
    writeLog("info", { scope: "startup", message: "Found restart-origin marker", threadTs, channel });
    unlinkSync(restartOriginPath);
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: ":white_check_mark: Bot restarted successfully.",
    });
    writeLog("info", { scope: "startup", message: "Notified restart origin thread", threadTs, channel });
  } catch {
    // No restart-origin file or already cleaned up
  }

  for (const [threadTs, query] of state.interruptedQueries.entries()) {
    if (query.reason !== "Bot restarted before query completed") continue;
    if (!query.channel) continue;
    try {
      await app.client.chat.postMessage({
        channel: query.channel,
        thread_ts: threadTs,
        text: ":white_check_mark: Bot restarted successfully.",
      });
      state.interruptedQueries.delete(threadTs);
      writeLog("info", {
        scope: "startup",
        message: "Notified interrupted thread of successful restart",
        threadTs,
      });
    } catch (err) {
      writeLog("error", {
        scope: "startup",
        message: "Failed to notify interrupted thread",
        threadTs,
        error: (err as Error).message,
      });
    }
  }
  state.saveSessions();
}

async function main(): Promise<void> {
  removeLegacyRuntimeLog();
  state.markRecoveredQueriesAsInterrupted();
  state.acquireProcessLock();
  await app.start();
  await notifyRestart();
  writeLog("info", {
    scope: "startup",
    message: "Agent Slack bot started",
    defaultCwd: DEFAULT_CWD,
    provider: AGENT_PROVIDER,
    model: AGENT_PROVIDER === "claude" ? CLAUDE_MODEL || null : null,
  });
}

main();
