import assert from "node:assert/strict";
import test from "node:test";
import { isChannelUserAllowed, parseChannelUserAllowlist } from "./access-control.js";
import { shouldRetryCodexTurn } from "./agents.js";
import { extractCodexTaskRequests } from "./codex-task-directive.js";
import { serializeError } from "./logger.js";
import { classifySlackFile, fetchThreadContext, isUploadableFilePath, startNativeTaskProgress } from "./slack.js";
import type { SlackApp, SlackStreamChunk } from "./types.js";

const disconnect = new Error(
  "stream disconnected before completion: websocket closed by server before response.completed",
);

test("restricts configured channels to explicitly allowed users", () => {
  const allowlist = parseChannelUserAllowlist("C_MINIMAX:U_TONY,C_MINIMAX:U_BACKUP,C_OTHER:U_OTHER");

  assert.equal(isChannelUserAllowed("C_MINIMAX", "U_TONY", allowlist), true);
  assert.equal(isChannelUserAllowed("C_MINIMAX", "U_BACKUP", allowlist), true);
  assert.equal(isChannelUserAllowed("C_MINIMAX", "U_SOMEONE_ELSE", allowlist), false);
  assert.equal(isChannelUserAllowed("C_UNRESTRICTED", "U_SOMEONE_ELSE", allowlist), true);
});

test("retries a first-attempt Codex disconnect when no side-effect events were emitted", () => {
  assert.equal(shouldRetryCodexTurn(disconnect, 1, 0), true);
});

test("does not retry after a command, file change, or MCP event may have had side effects", () => {
  assert.equal(shouldRetryCodexTurn(disconnect, 1, 1), false);
});

test("does not retry the final attempt or unrelated failures", () => {
  assert.equal(shouldRetryCodexTurn(disconnect, 2, 0), false);
  assert.equal(shouldRetryCodexTurn(new Error("rate limit exceeded"), 1, 0), false);
});

test("extracts and hides top-level Codex task directives", () => {
  const cwd64 = Buffer.from("/Users/thui/Desktop/code/thumbnail-editor").toString("base64");
  const prompt64 = Buffer.from("Run bounded contract smokes.\nDo not modify code.").toString("base64");
  const result = extractCodexTaskRequests(
    `I will create that as a visible task.\n::create-codex-task{cwd64="${cwd64}" prompt64="${prompt64}"}`,
  );

  assert.equal(result.text, "I will create that as a visible task.");
  assert.deepEqual(result.requests, [{
    cwd: "/Users/thui/Desktop/code/thumbnail-editor",
    prompt: "Run bounded contract smokes.\nDo not modify code.",
  }]);
});

test("verbose error diagnostics include causes and redact credentials", () => {
  const cause = Object.assign(new Error("socket closed"), {
    code: "ECONNRESET",
    stderr: "Authorization: Bearer secret-token-value",
  });
  const serialized = serializeError(new Error("Codex failed", { cause }));

  assert.equal(serialized.name, "Error");
  assert.match(String(serialized.stack), /Codex failed/);
  assert.deepEqual(serialized.cause, {
    name: "Error",
    message: "socket closed",
    stack: (serialized.cause as Record<string, unknown>).stack,
    code: "ECONNRESET",
    stderr: "Authorization: [REDACTED]",
  });
});

test("allows audio references to be uploaded to Slack", () => {
  assert.equal(isUploadableFilePath("/tmp/voice-reference.mp3"), true);
  assert.equal(isUploadableFilePath("/tmp/voice-reference.WAV"), true);
  assert.equal(isUploadableFilePath("/tmp/secret.env"), false);
});

test("recognizes Slack voice notes as inbound audio", () => {
  assert.deepEqual(
    classifySlackFile({ id: "F123", name: "audio_message.m4a", mimetype: "audio/mp4" }),
    { ext: "m4a", kind: "audio" },
  );
});

test("recognizes Slack PDF attachments as inbound documents", () => {
  assert.deepEqual(
    classifySlackFile({ id: "F456", name: "billing-guide.pdf", mimetype: "application/pdf" }),
    { ext: "pdf", kind: "document" },
  );
});

test("collects first-tag thread context and attachments before the triggering message", async () => {
  const app = {
    client: {
      conversations: {
        async replies() {
          return {
            messages: [
              { ts: "10.000", user: "U1", text: "", files: [{ id: "F1", name: "source.mp4", mimetype: "video/mp4" }] },
              { ts: "20.000", user: "U1", text: "source prompt" },
              { ts: "30.000", user: "U2", text: "<@UBOT> analyze this" },
              { ts: "31.000", bot_id: "B1", text: "Working" },
            ],
          };
        },
      },
    },
  } as unknown as SlackApp;

  const context = await fetchThreadContext(app, "C1", "10.000", "30.000", "UBOT");
  assert.match(context.text || "", /source\.mp4/);
  assert.match(context.text || "", /source prompt/);
  assert.doesNotMatch(context.text || "", /analyze this|Working/);
  assert.deepEqual(context.files.map((file) => file.id), ["F1"]);
});

test("starts subsequent thread context after the previous bot tag", async () => {
  const app = {
    client: {
      conversations: {
        async replies() {
          return {
            messages: [
              { ts: "10.000", user: "U1", text: "old context" },
              { ts: "20.000", user: "U2", text: "<@UBOT> first request" },
              { ts: "25.000", bot_id: "B1", text: "first answer" },
              { ts: "30.000", user: "U1", text: "new source context" },
              { ts: "40.000", user: "U2", text: "<@UBOT> next request" },
            ],
          };
        },
      },
    },
  } as unknown as SlackApp;

  const context = await fetchThreadContext(app, "C1", "10.000", "40.000", "UBOT");
  assert.equal(context.text, "Slack thread context before this request:\n\n<U1>: new source context");
});

test("restarts an expired Slack progress stream once and retries the failed update", async () => {
  const starts: string[] = [];
  const appends: Array<{ ts: string; chunks: SlackStreamChunk[] }> = [];
  const stops: string[] = [];
  let appendAttempt = 0;
  const app = {
    client: {
      chat: {
        async startStream() {
          const ts = `stream-${starts.length + 1}`;
          starts.push(ts);
          return { ts };
        },
        async appendStream(args: { ts: string; chunks: SlackStreamChunk[] }) {
          appendAttempt += 1;
          appends.push(args);
          if (appendAttempt === 1) throw new Error("message_not_in_streaming_state");
        },
        async stopStream(args: { ts: string }) {
          stops.push(args.ts);
        },
      },
    },
  } as unknown as SlackApp;

  const progress = await startNativeTaskProgress(app, "C123", "123.456", "U123", "T123");
  progress.addMessage("message-1", "Generation submitted");
  await progress.stop("Done");

  assert.deepEqual(starts, ["stream-1", "stream-2"]);
  assert.deepEqual(appends.map(({ ts }) => ts), ["stream-1", "stream-2"]);
  assert.equal(appends[1].chunks[0]?.type, "task_update");
  assert.deepEqual(stops, ["stream-2"]);
  assert.equal(progress.ts, "stream-2");
});
