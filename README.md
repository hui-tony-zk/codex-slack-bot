# Codex Slack Bot

Slack agent built around Codex sessions. Claude remains available as an experimental, unverified provider through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Open it from Slack's agent entry point, DM it, or @mention it in threads.

## Setup

```bash
cp .env.example .env   # fill in tokens
npm install
npm run dev            # dev mode (auto-restart on file changes)
npm start              # production
./restart-bot.sh       # restart as background daemon
```

Import [`manifest.json`](./manifest.json) into the Slack app configuration, create an app-level token with `connections:write`, and reinstall the app after adding the declared bot scopes. The manifest enables Slack's `agent_view` while preserving DM and `@mention` events.

### Required env vars

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | `xoxb-...` from OAuth & Permissions |
| `SLACK_APP_TOKEN` | `xapp-...` from App-Level Tokens (needs `connections:write`) |
| `DEFAULT_CWD` | Working directory for agent sessions |
| `AGENT_PROVIDER` | `codex` or `claude` (default: `codex`) |
| `DEFAULT_MODEL` / `CODEX_MODEL` | Codex model (default: `gpt-5.5`) |
| `CLAUDE_MODEL` | Optional Claude model override when `AGENT_PROVIDER=claude` |
| `MAX_TURNS` | Claude max turns per request (default: 50) |
| `CODEX_MODEL_REASONING_EFFORT` | Codex reasoning effort: `minimal`, `low`, `medium`, `high`, or `xhigh` (default: `high`) |
| `CODEX_SANDBOX_MODE` | Optional sandbox mode (default: `danger-full-access`) |
| `CODEX_APPROVAL_POLICY` | Optional approval policy (default: `never`) |
| `CODEX_PATH` | Optional Codex CLI override; unset uses the CLI runtime bundled with `@openai/codex-sdk` |

## Features

- **Native Slack agent** — available from Slack's agent entry point and Messages tab
- **DM or @mention** — responds in agent DMs and when tagged in channel threads
- **Thread context** — fetches messages since last bot reply when tagged mid-thread
- **Experimental provider switching** — Codex is supported; `AGENT_PROVIDER=claude` remains available but unverified
- **Session persistence** — resumes sessions across messages in the same thread; survives bot restarts
- **Image attachments** — downloads images from Slack and passes them to the active provider
- **Video attachments** — downloads videos locally so the agent can choose request-specific processing
- **File delivery** — uploads agent-produced images, PDFs, audio, and videos back into the Slack thread
- **Progress tracking** — renders tool execution as native Slack plan/task updates
- **Typing indicator** — native Slack status via `assistant.threads.setStatus`
- **Crash recovery** — automatically restarts after crashes (non-zero exit), stops cleanly on intentional shutdown
- **Restart confirmation** — posts confirmation after `/restart`

### Commands (in Slack)

Slack does not deliver slash commands from agent threads. Use the `!` forms in the agent interface; the legacy `/` forms remain supported wherever Slack delivers them as messages.

| Agent command | Legacy form | Effect |
|---------------|-------------|--------|
| `!status` | `/status` | Show active/interrupted queries |
| `!cwd <path>` | `/cwd <path>` | Set working directory for thread |
| `!new` | `/new` | Clear session, start fresh |
| `!restart` | `/restart` | Restart bot process |

## File structure

```
src/
  index.ts        — entry point, Slack event routing, startup/shutdown
  handler.ts      — message orchestration, agent query loop, progress updates
  commands.ts     — /status, /cwd, /new, /restart
  slack.ts        — thread context fetch, image download, typing status
  state.ts        — session/query persistence (JSON files), process lock
  config.ts       — paths, env constants
  formatting.ts   — Slack block formatting, tool trace rendering
  prompt.ts       — system prompt loading (from system_prompt.txt or default)
  types.ts        — shared types (BotEvent, SlackApp, etc.)
  logger.ts       — JSON file logging with rotation
```

```
.data/              — runtime data (gitignored)
  sessions.json     — persisted session IDs + CWDs per thread
  active.json       — in-flight and interrupted queries
  bot.log           — structured JSON logs
  bot.pid           — process lock file
  attachments/      — downloaded Slack images
restart-bot.sh      — daemon restart script (stops wrapper + bot, spawns fresh)
run-loop.sh         — crash-recovery wrapper (restarts bot on non-zero exit)
system_prompt.txt   — custom system prompt (optional, gitignored)
```
