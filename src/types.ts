export type LogLevel = "info" | "error";

export type LogPayload = {
  scope?: string;
  threadTs?: string | null;
  message: string;
  [key: string]: unknown;
};

export type ActiveQuery = {
  threadTs: string;
  user?: string;
  channel?: string;
  text?: string;
  cwd?: string;
  sessionId?: string | null;
  startedAt?: string;
  thinkingTs?: string | null;
  phase?: string;
  provider?: string;
  currentTool?: { id: string; name: string; detail: string };
  completedTools?: Array<{ id: string; name: string; detail: string }>;
  lastProgressAt?: string;
  interruptedAt?: string;
  reason?: string;
  status?: string;
  detail?: string;
};

export type SlackFile = {
  id: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  filetype?: string;
};

export type BotEvent = {
  thread_ts?: string;
  ts: string;
  text: string;
  user: string;
  channel: string;
  channel_type?: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFile[];
};

export type BotEventEnvelope = {
  team_id?: string;
  enterprise_id?: string;
  authorizations?: Array<{ user_id?: string }>;
};

export type SayArgs = {
  text: string;
  thread_ts: string;
  blocks?: unknown[];
};

export type SayResult = { ts: string };
export type SayFn = (args: SayArgs) => Promise<SayResult>;

export type SlackApp = {
  client: {
    assistant: {
      threads: {
        setStatus(args: { channel_id: string; thread_ts: string; status: string }): Promise<unknown>;
      };
    };
    chat: {
      startStream(args: {
        channel: string;
        thread_ts: string;
        task_display_mode: "plan";
        chunks: SlackStreamChunk[];
        recipient_team_id?: string;
        recipient_user_id?: string;
      }): Promise<{ ts?: string }>;
      appendStream(args: { channel: string; ts: string; chunks: SlackStreamChunk[] }): Promise<unknown>;
      stopStream(args: { channel: string; ts: string; chunks?: SlackStreamChunk[] }): Promise<unknown>;
      postMessage(args: { channel: string; thread_ts: string; text: string }): Promise<unknown>;
      update(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<unknown>;
    };
    conversations: {
      replies(args: { channel: string; ts: string; limit?: number }): Promise<{
        messages?: Array<{
          user?: string;
          bot_id?: string;
          text?: string;
          ts: string;
          files?: SlackFile[];
        }>;
      }>;
    };
    files: {
      uploadV2(args: {
        channel_id: string;
        thread_ts: string;
        file: Buffer | string;
        filename: string;
        title?: string;
      }): Promise<unknown>;
    };
  };
};

export type SlackStreamChunk =
  | { type: "plan_update"; title: string }
  | {
      type: "task_update";
      id: string;
      title: string;
      status: "pending" | "in_progress" | "complete" | "error";
      details?: string;
    };
