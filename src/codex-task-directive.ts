import { Buffer } from "node:buffer";

export type CodexTaskRequest = {
  cwd: string;
  prompt: string;
};

const TASK_DIRECTIVE = /(?:^|\n)::create-codex-task\{cwd64="([A-Za-z0-9+/_=-]+)" prompt64="([A-Za-z0-9+/_=-]+)"\}(?=\n|$)/g;

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

export function extractCodexTaskRequests(text: string): {
  text: string;
  requests: CodexTaskRequest[];
} {
  const requests: CodexTaskRequest[] = [];
  const cleaned = text.replace(TASK_DIRECTIVE, (_match, cwd64: string, prompt64: string) => {
    const cwd = decodeBase64(cwd64).trim();
    const prompt = decodeBase64(prompt64).trim();
    if (cwd && prompt) requests.push({ cwd, prompt });
    return "";
  });

  return {
    text: cleaned.replace(/\n{3,}/g, "\n\n").trim(),
    requests,
  };
}
