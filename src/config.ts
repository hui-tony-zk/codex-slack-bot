import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(__dirname);
const DATA_DIR = join(ROOT_DIR, ".data");

mkdirSync(DATA_DIR, { recursive: true });

export const PATHS = {
  ROOT_DIR,
  DATA_DIR,
  STATE_FILE: join(DATA_DIR, "sessions.json"),
  ACTIVE_FILE: join(DATA_DIR, "active.json"),
  LOG_FILE: join(DATA_DIR, "bot.log"),
  LOG_ROTATED_FILE: join(DATA_DIR, "bot.log.1"),
  PID_FILE: join(DATA_DIR, "bot.pid"),
  RUNTIME_LOG_FILE: join(DATA_DIR, "runtime.log"),
} as const;

export const DEFAULT_CWD = process.env.DEFAULT_CWD || process.cwd();
export const AGENT_PROVIDER = process.env.AGENT_PROVIDER === "claude" ? "claude" : "codex";
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "";
export const MAX_TURNS = parseInt(process.env.MAX_TURNS || "50", 10);
export const MAX_LOG_BYTES = parseInt(process.env.MAX_LOG_BYTES || `${5 * 1024 * 1024}`, 10);
export const MAX_ERROR_DETAIL_CHARS = parseInt(process.env.MAX_ERROR_DETAIL_CHARS || "2000", 10);
