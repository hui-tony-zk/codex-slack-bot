import { createWriteStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PATHS } from "./config.js";
import { writeLog } from "./logger.js";
import type { ToolTrace } from "./agents.js";
import type { SlackApp, SlackFile, SlackStreamChunk } from "./types.js";

const ATTACHMENTS_DIR = join(PATHS.DATA_DIR, "attachments");
mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const VIDEO_TYPES = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv", "mpg", "mpeg", "qt"]);
const AUDIO_TYPES = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aif", "aiff"]);
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
};

export type DownloadedSlackFiles = {
  imagePaths: string[];
  videoPaths: string[];
  audioPaths: string[];
};

export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

export function classifySlackFile(file: SlackFile): { ext: string; kind: "image" | "video" | "audio" } | null {
  const rawExt = file.filetype || file.name?.split(".").pop() || "";
  const safeExt = rawExt.toLowerCase().replace(/[^a-z0-9]/g, "");
  const mime = file.mimetype?.toLowerCase() || "";
  const ext = MIME_EXTENSIONS[mime] || safeExt || "bin";

  if (mime.startsWith("image/") || IMAGE_TYPES.has(ext)) return { ext, kind: "image" };
  if (mime.startsWith("video/") || VIDEO_TYPES.has(ext)) return { ext, kind: "video" };
  if (mime.startsWith("audio/") || AUDIO_TYPES.has(ext)) return { ext, kind: "audio" };
  return null;
}

export async function downloadSlackFiles(files: SlackFile[], botToken: string): Promise<DownloadedSlackFiles> {
  const downloaded: DownloadedSlackFiles = { imagePaths: [], videoPaths: [], audioPaths: [] };
  for (const file of files) {
    if (!file.url_private) continue;
    const attachmentType = classifySlackFile(file);
    if (!attachmentType) {
      writeLog("info", {
        scope: "attachment",
        message: "Skipped unsupported Slack attachment",
        fileId: file.id,
        name: file.name || null,
        mimetype: file.mimetype || null,
        filetype: file.filetype || null,
      });
      continue;
    }
    const { ext, kind } = attachmentType;
    const filename = `${file.id}.${ext}`;
    const filepath = join(ATTACHMENTS_DIR, filename);
    try {
      const resp = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!resp.ok) {
        writeLog("error", { scope: "attachment", message: "Download failed", fileId: file.id, status: resp.status });
        continue;
      }
      if (!resp.body) throw new Error("Download response had no body");
      await pipeline(Readable.fromWeb(resp.body as any), createWriteStream(filepath));
      const destination = kind === "image" ? downloaded.imagePaths
        : kind === "video" ? downloaded.videoPaths
        : downloaded.audioPaths;
      destination.push(filepath);
    } catch (err) {
      try {
        unlinkSync(filepath);
      } catch {}
      writeLog("error", { scope: "attachment", message: "Download error", fileId: file.id, error: (err as Error).message });
    }
  }
  return downloaded;
}

export async function fetchThreadContext(
  app: SlackApp,
  channel: string,
  threadTs: string,
  currentTs: string,
  botUserId: string | undefined,
): Promise<{ text: string | null; files: SlackFile[] }> {
  try {
    const result = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50,
    });
    const priorMessages = (result.messages || []).filter((message) => message.ts < currentTs);
    let previousTagIndex = -1;
    if (botUserId) {
      for (let index = priorMessages.length - 1; index >= 0; index -= 1) {
        const message = priorMessages[index];
        if (!message.bot_id && message.text?.includes(`<@${botUserId}>`)) {
          previousTagIndex = index;
          break;
        }
      }
    }
    const relevantMessages = previousTagIndex >= 0
      ? priorMessages.slice(previousTagIndex + 1)
      : priorMessages;
    const files = relevantMessages
      .filter((message) => !message.bot_id)
      .flatMap((message) => message.files || []);

    const lines = relevantMessages
      .filter((m) => !m.bot_id)
      .map((m) => {
        const messageText = stripMention(m.text || "");
        const fileText = (m.files || []).map((file) => `[attached file: ${file.name || file.id}]`).join(" ");
        return `<${m.user || "unknown"}>: ${[messageText, fileText].filter(Boolean).join(" ")}`;
      })
      .filter((line) => !line.endsWith(": "));
    const text = lines.length > 0
      ? `Slack thread context before this request:\n\n${lines.join("\n")}`
      : null;
    return { text, files };
  } catch (err) {
    writeLog("error", {
      scope: "thread-context",
      message: "Failed to fetch thread history",
      error: (err as Error).message,
    });
    return { text: null, files: [] };
  }
}

const UPLOADABLE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "pdf",
  "mp4", "mov", "m4v", "webm", "avi", "mkv", "mpg", "mpeg", "qt",
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aif", "aiff",
]);

export function isUploadableFilePath(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return UPLOADABLE_EXTENSIONS.has(ext);
}

/** Extract file paths from structured "📎 /path/to/file" lines in the result text. */
export function extractAttachmentPaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^📎\s+(\/.+?)\s*$/);
    if (match && existsSync(match[1])) paths.push(match[1]);
  }
  return [...new Set(paths)];
}

/** Strip "📎 /path" lines from text before sending to Slack. */
export function stripAttachmentLines(text: string): string {
  return text.split("\n").filter((line) => !line.match(/^📎\s+\//)).join("\n").trimEnd();
}

/** Upload a file to a Slack thread. */
export async function uploadFileToThread(
  app: SlackApp,
  channel: string,
  threadTs: string,
  filePath: string,
  title?: string,
): Promise<void> {
  if (!isUploadableFilePath(filePath)) {
    writeLog("error", {
      scope: "upload",
      message: "Skipped file with unsupported extension",
      filePath,
      channel,
      threadTs,
    });
    return;
  }

  try {
    await app.client.files.uploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      file: filePath,
      filename: basename(filePath),
      title: title || basename(filePath),
    });
    writeLog("info", { scope: "upload", message: "Uploaded file to Slack", filePath, channel, threadTs });
  } catch (err) {
    writeLog("error", { scope: "upload", message: "File upload failed", filePath, error: (err as Error).message });
  }
}

export async function setTypingStatus(app: SlackApp, channel: string, threadTs: string, status: string): Promise<void> {
  try {
    await app.client.assistant.threads.setStatus({ channel_id: channel, thread_ts: threadTs, status });
  } catch {
    // assistant.threads.setStatus may not be available — silently ignore
  }
}

function truncateTaskText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function taskChunk(tool: ToolTrace, status: "in_progress" | "complete" | "error"): SlackStreamChunk {
  return {
    type: "task_update",
    id: tool.id,
    title: truncateTaskText(tool.name, 80),
    status,
    ...(tool.detail ? { details: truncateTaskText(tool.detail, 160) } : {}),
  };
}

function isExpiredSlackStreamError(error: unknown): boolean {
  const source = error as { data?: { error?: unknown }; code?: unknown };
  return source?.data?.error === "message_not_in_streaming_state"
    || source?.code === "message_not_in_streaming_state"
    || (error instanceof Error && error.message.includes("message_not_in_streaming_state"));
}

export type NativeTaskProgress = {
  ts: string | null;
  update(tool: ToolTrace, status: "in_progress" | "complete" | "error"): void;
  addMessage(id: string, text: string): void;
  stop(title: string): Promise<void>;
};

/** Render agent tool activity with Slack's native plan/task streaming UI. */
export async function startNativeTaskProgress(
  app: SlackApp,
  channel: string,
  threadTs: string,
  recipientUserId: string,
  recipientTeamId?: string,
): Promise<NativeTaskProgress> {
  let streamTs: string | null = null;
  let stopped = false;
  let queue = Promise.resolve();
  let lastTask: { id: string; title: string } | null = null;
  let recoveryAttempted = false;
  const displayIds = new Map<string, string>();
  const lastTaskState = new Map<string, string>();

  const startStream = async (): Promise<string> => {
    const response = await app.client.chat.startStream({
      channel,
      thread_ts: threadTs,
      task_display_mode: "plan",
      chunks: [{ type: "plan_update", title: "Working" }],
      recipient_user_id: recipientUserId,
      ...(recipientTeamId ? { recipient_team_id: recipientTeamId } : {}),
    });
    if (!response.ts) throw new Error("chat.startStream returned no message timestamp");
    return response.ts;
  };

  const appendChunks = async (chunks: SlackStreamChunk[]): Promise<void> => {
    if (!streamTs) return;
    try {
      await app.client.chat.appendStream({ channel, ts: streamTs, chunks });
      return;
    } catch (err) {
      if (!recoveryAttempted && isExpiredSlackStreamError(err)) {
        recoveryAttempted = true;
        const expiredTs = streamTs;
        try {
          streamTs = await startStream();
          await app.client.chat.appendStream({ channel, ts: streamTs, chunks });
          writeLog("info", {
            scope: "native-task-progress",
            threadTs,
            message: "Restarted expired native task progress stream",
            expiredTs,
            replacementTs: streamTs,
          });
          return;
        } catch (recoveryError) {
          writeLog("error", {
            scope: "native-task-progress",
            threadTs,
            message: "Failed to restart expired native task progress stream",
            expiredTs,
            error: (recoveryError as Error).message,
          });
          throw recoveryError;
        }
      }
      throw err;
    }
  };

  try {
    streamTs = await startStream();
  } catch (err) {
    writeLog("error", {
      scope: "native-task-progress",
      threadTs,
      message: "Failed to start native task progress",
      error: (err as Error).message,
    });
  }

  return {
    get ts() {
      return streamTs;
    },
    update(tool, status) {
      if (!streamTs || stopped) return;
      let displayId = displayIds.get(tool.id);
      if (!displayId) {
        displayId = lastTask?.title === tool.name ? lastTask.id : tool.id;
        displayIds.set(tool.id, displayId);
      }
      const displayTool = displayId === tool.id ? tool : { ...tool, id: displayId };
      const signature = `${status}\n${displayTool.name}\n${displayTool.detail}`;
      if (lastTaskState.get(displayId) === signature) return;
      lastTaskState.set(displayId, signature);
      lastTask = { id: displayId, title: displayTool.name };
      queue = queue
        .then(() => appendChunks([taskChunk(displayTool, status)]))
        .catch((err) => {
          writeLog("error", {
            scope: "native-task-progress",
            threadTs,
            message: "Failed to update native task progress",
            error: (err as Error).message,
          });
        });
    },
    addMessage(id, text) {
      if (!streamTs || stopped) return;
      const normalized = text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_`#>]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) return;
      const messageTask: ToolTrace = {
        id: `message:${id}`,
        name: truncateTaskText(normalized, 120),
        detail: "",
      };
      queue = queue
        .then(() => appendChunks([taskChunk(messageTask, "complete")]))
        .catch((err) => {
          writeLog("error", {
            scope: "native-task-progress",
            threadTs,
            message: "Failed to add native progress message",
            error: (err as Error).message,
          });
        });
    },
    async stop(title) {
      if (!streamTs || stopped) return;
      stopped = true;
      await queue;
      try {
        await app.client.chat.stopStream({
          channel,
          ts: streamTs,
          chunks: [{ type: "plan_update", title }],
        });
      } catch (err) {
        writeLog("error", {
          scope: "native-task-progress",
          threadTs,
          message: "Failed to stop native task progress",
          error: (err as Error).message,
        });
      }
    },
  };
}
