import { createTopLevelCodexTask, decodeSessionId, encodeSessionId, getProviderModel, runAgentQuery, steerAgentQuery } from "./agents.js";
import type { AgentProvider, BuiltPrompt, ToolTrace } from "./agents.js";
import { extractCodexTaskRequests } from "./codex-task-directive.js";
import { AGENT_PROVIDER, DEFAULT_CWD, MAX_ERROR_DETAIL_CHARS } from "./config.js";
import { handleCommand } from "./commands.js";
import { formatElapsedMs, formatResultBlocks } from "./formatting.js";
import { logThread, serializeError, writeLog } from "./logger.js";
import { downloadSlackFiles, extractAttachmentPaths, fetchThreadContext, setTypingStatus, startNativeTaskProgress, stripAttachmentLines, stripMention, uploadFileToThread } from "./slack.js";
import type { BotEvent, BotEventEnvelope, SayFn, SlackApp } from "./types.js";

type StateStore = ReturnType<typeof import("./state.js").createStateStore>;

async function buildPrompt(
  app: SlackApp,
  event: BotEvent,
  text: string,
  threadTs: string,
  botUserId: string | undefined,
  includeThreadContext = true,
): Promise<BuiltPrompt> {
  // Images are model inputs; video and audio remain local for tool-based processing.
  const attachmentNotes: string[] = [];
  let imagePaths: string[] = [];
  let audioPaths: string[] = [];
  let threadContext: string | null = null;
  let threadFiles = [] as NonNullable<BotEvent["files"]>;
  if (includeThreadContext && event.thread_ts) {
    const context = await fetchThreadContext(app, event.channel, threadTs, event.ts, botUserId);
    threadContext = context.text;
    threadFiles = context.files;
  }

  const files = [...threadFiles, ...(event.files || [])]
    .filter((file, index, all) => all.findIndex((candidate) => candidate.id === file.id) === index);
  if (files.length) {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (botToken) {
      const downloaded = await downloadSlackFiles(files, botToken);
      imagePaths = downloaded.imagePaths;
      audioPaths = downloaded.audioPaths;
      if (imagePaths.length > 0) {
        attachmentNotes.push(`The user attached ${imagePaths.length} image(s):\n${imagePaths.map((p) => `- ${p}`).join("\n")}`);
        logThread(threadTs, "Downloaded image attachments", { count: imagePaths.length, paths: imagePaths });
      }
      if (downloaded.videoPaths.length > 0) {
        attachmentNotes.push(
          `The user attached ${downloaded.videoPaths.length} video(s), downloaded to local paths:\n${downloaded.videoPaths.map((p) => `- ${p}`).join("\n")}\nChoose how to inspect or process each video based on the user's request.`,
        );
        logThread(threadTs, "Downloaded video attachments", {
          count: downloaded.videoPaths.length,
          paths: downloaded.videoPaths,
        });
      }
      if (audioPaths.length > 0) {
        attachmentNotes.push(
          `The user attached ${audioPaths.length} audio file(s), downloaded to local paths:\n${audioPaths.map((p) => `- ${p}`).join("\n")}\nChoose how to inspect or process each audio file based on the user's request.`,
        );
        logThread(threadTs, "Downloaded audio attachments", { count: audioPaths.length, paths: audioPaths });
      }
    }
  }
  const attachmentNote = attachmentNotes.length ? `\n\n${attachmentNotes.join("\n\n")}` : "";
  const requestText = text.trim() || "The user sent attachment(s) without additional instructions. Ask what they want done with them.";

  // Fetch missed thread messages
  let prompt = requestText + attachmentNote;
  if (threadContext) {
    prompt = `${threadContext}\n\n---\n\nUser's request: ${requestText}${attachmentNote}`;
    logThread(threadTs, "Prepended thread context to prompt", {
      threadFileCount: threadFiles.length,
      botUserId: botUserId || null,
    });
  }

  return { text: prompt, imagePaths, audioPaths };
}

export function createMessageHandler(app: SlackApp, state: StateStore) {
  return async function handleMessage({
    event,
    body,
    say,
  }: {
    event: BotEvent;
    body?: BotEventEnvelope;
    say: SayFn;
  }): Promise<void> {
    const threadTs = event.thread_ts || event.ts;
    const text = stripMention(event.text);
    const user = event.user;
    const botUserId = body?.authorizations?.find((authorization) => authorization.user_id)?.user_id
      || event.text.match(/<@([A-Z0-9]+)>/)?.[1];

    logThread(threadTs, "Incoming user message", {
      user,
      channel: event.channel,
      text,
      slackTs: event.ts,
    });

    if (!text.trim() && !event.files?.length) {
      await say({ text: "Give me a task!", thread_ts: threadTs });
      logThread(threadTs, "Rejected empty message");
      return;
    }

    const { handled } = await handleCommand(text.trim(), threadTs, event.channel, say, state);
    if (handled) return;

    const cwd = state.threadCwd.get(threadTs) || DEFAULT_CWD;
    const storedSessionId = state.threadSessions.get(threadTs);
    const provider = AGENT_PROVIDER as AgentProvider;
    const existingSessionId = decodeSessionId(provider, storedSessionId);
    const providerModel = getProviderModel(provider);

    if (provider === "codex" && state.activeQueries.has(threadTs)) {
      try {
        const prompt = await buildPrompt(app, event, text, threadTs, botUserId);
        const steered = await steerAgentQuery(threadTs, prompt);
        if (!steered) throw new Error("The active Codex turn ended before the follow-up could be steered");
        state.updateActiveQuery(threadTs, {
          phase: "steered",
          text: `${state.activeQueries.get(threadTs)?.text || ""}\nFollow-up: ${text}`.trim(),
          lastProgressAt: new Date().toISOString(),
        });
        await say({ text: ":leftwards_arrow_with_hook: Added to the active task.", thread_ts: threadTs });
        return;
      } catch (err) {
        writeLog("error", {
          scope: "codex-steer",
          threadTs,
          message: "Failed to steer active Codex turn",
          error: serializeError(err),
        });
        await say({ text: `:x: Could not add that follow-up to the active task: ${(err as Error).message}`, thread_ts: threadTs });
        return;
      }
    }

    logThread(threadTs, `Starting ${provider} query`, { cwd, model: providerModel || null, sessionId: existingSessionId || null });
    state.setActiveQuery(threadTs, {
      threadTs,
      user,
      channel: event.channel,
      text,
      cwd,
      sessionId: existingSessionId || null,
      startedAt: new Date().toISOString(),
      phase: "starting",
      thinkingTs: null,
      provider,
    });

    await setTypingStatus(app, event.channel, threadTs, "is thinking...");

    const queryStartTime = Date.now();
    const progress = await startNativeTaskProgress(
      app,
      event.channel,
      threadTs,
      user,
      body?.enterprise_id || body?.team_id,
    );
    logThread(threadTs, "Started native task progress", { progressTs: progress.ts });
    state.updateActiveQuery(threadTs, { phase: "running", thinkingTs: progress.ts });

    let sessionId = existingSessionId;
    const completedTools: ToolTrace[] = [];
    let currentTool: ToolTrace | null = null;

    try {
      const prompt = await buildPrompt(app, event, text, threadTs, botUserId);
      const onSession = (newSessionId: string) => {
        sessionId = newSessionId;
        state.updateActiveQuery(threadTs, { sessionId, phase: "initialized" });
      };
      const onTool = (
        tool: ToolTrace | null,
        completedTool?: ToolTrace,
        completedStatus: "complete" | "error" = "complete",
      ) => {
        if (currentTool && completedTool === undefined && provider === "claude" && tool?.id !== currentTool.id) {
          completedTools.push(currentTool);
          progress.update(currentTool, "complete");
        }
        if (completedTool) {
          completedTools.push(completedTool);
          if (provider === "claude") progress.update(completedTool, completedStatus);
        }
        currentTool = tool;
        if (tool && provider === "claude") {
          progress.update(tool, "in_progress");
        }
        const now = Date.now();
        const statusText = currentTool ? `is running ${currentTool.name}...` : "is thinking...";
        void setTypingStatus(app, event.channel, threadTs, statusText);
        state.updateActiveQuery(threadTs, {
          phase: currentTool ? `tool:${currentTool.name}` : "running",
          currentTool,
          completedTools: completedTools.slice(-10),
          lastProgressAt: new Date(now).toISOString(),
        });
      };

      const resultText = await runAgentQuery(provider, {
        prompt,
        cwd,
        existingSessionId,
        threadTs,
        onSession,
        onTool,
        onAgentMessage: (id, message) => progress.addMessage(id, message),
      });

      if (sessionId) {
        state.threadSessions.set(threadTs, encodeSessionId(provider, sessionId));
        state.saveSessions();
      }

      if (currentTool) {
        completedTools.push(currentTool);
        if (provider === "claude") progress.update(currentTool, "complete");
        currentTool = null;
      }

      logThread(threadTs, `${provider} query completed`, {
        sessionId,
        resultChars: resultText.length,
        resultText,
      });
      state.completeActiveQuery(threadTs);

      const elapsedMs = Date.now() - queryStartTime;

      await setTypingStatus(app, event.channel, threadTs, "");
      await progress.stop(`Done (${formatElapsedMs(elapsedMs)})`);

      // Execute hidden top-level task requests before posting the visible answer.
      const taskDirectives = extractCodexTaskRequests(resultText);
      const taskNotices: string[] = [];
      for (const request of taskDirectives.requests) {
        try {
          const created = await createTopLevelCodexTask({
            ...request,
            sourceThreadTs: threadTs,
          });
          taskNotices.push(`Created Codex task \`${created.threadId}\` in \`${request.cwd}\`; it is running and visible in the Codex UI.`);
        } catch (error) {
          writeLog("error", {
            scope: "top-level-codex-task",
            threadTs,
            message: "Could not create requested top-level Codex task",
            cwd: request.cwd,
            error: serializeError(error),
          });
          taskNotices.push(`:x: Could not create the requested Codex task: ${(error as Error).message}`);
        }
      }

      // Extract and upload any attached files before posting the text.
      const attachmentPaths = extractAttachmentPaths(taskDirectives.text);
      const cleanedResult = stripAttachmentLines(taskDirectives.text);

      const fallbackText = [cleanedResult, ...taskNotices].filter(Boolean).join("\n\n") || "(no output)";
      await say({
        text: fallbackText,
        blocks: formatResultBlocks(cleanedResult),
        thread_ts: threadTs,
      });
      logThread(threadTs, "Posted result as new message", {
        channel: event.channel,
        progressTs: progress.ts,
        text: fallbackText,
      });

      if (attachmentPaths.length > 0) {
        logThread(threadTs, "Uploading attachments from result", {
          count: attachmentPaths.length,
          paths: attachmentPaths,
        });
        for (const attachmentPath of attachmentPaths) {
          await uploadFileToThread(app, event.channel, threadTs, attachmentPath);
        }
      }
    } catch (err) {
      await setTypingStatus(app, event.channel, threadTs, "");
      if (currentTool && provider === "claude") progress.update(currentTool, "error");
      await progress.stop("Failed");
      const detail = [String((err as any).stderr || ""), String((err as any).stdout || "")]
        .filter(Boolean)
        .join("\n")
        .trim();
      const errorDetail = [detail].filter(Boolean).join("\n").trim();
      writeLog("error", {
        scope: "thread",
        threadTs,
        message: `${provider} query failed`,
        error: serializeError(err),
        detail: errorDetail,
        provider,
        model: providerModel || null,
        cwd,
        sessionId: sessionId || null,
        elapsedMs: Date.now() - queryStartTime,
        phase: currentTool ? `tool:${currentTool.name}` : "running",
        completedToolCount: completedTools.length,
      });
      state.failActiveQuery(threadTs, {
        sessionId,
        interruptedAt: new Date().toISOString(),
        reason: (err as Error).message,
        detail: errorDetail,
      });
      const errMsg = `:x: Failed: ${(err as Error).message}${errorDetail ? `\n\`\`\`${errorDetail.slice(0, 300)}\`\`\`` : ""}`;
      await say({ text: errMsg, thread_ts: threadTs });
      logThread(threadTs, "Posted Slack failure reply", {
        channel: event.channel,
        error: (err as Error).message,
        detail: errorDetail,
      });
    }
  };
}
