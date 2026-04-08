#!/usr/bin/env node

import {
  spawn,
  execFileSync,
  execSync,
  type ChildProcess,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

type RuntimeKind = "claude_code" | "codex";

type RuntimeCatalogEntry = {
  runtimeKind: RuntimeKind;
  executablePath?: string;
  status:
    | "available"
    | "missing_binary"
    | "broken_path"
    | "unsupported_platform"
    | "runtime_error";
  version?: string;
  metadata?: Record<string, unknown>;
  lastError?: string;
};

type DaemonConfig = {
  serverUrl: string;
  apiKey: string;
  heartbeatMs: number;
  logLevel: LogLevel;
};

type AgentStartMessage = {
  type: "agent:start";
  remoteAgentId: string;
  runtimeKind: RuntimeKind;
  runtimePath?: string | null;
  localRootPath?: string | null;
  sessionId?: string | null;
  serverUrl?: string;
};

type DeliveryMessage = {
  type: "agent:deliver";
  deliveries: Delivery[];
};

type ConnectedMessage = {
  type: "connected";
  machineId: string;
  sessionId: string;
};

type Delivery = {
  remoteAgentId: string;
  deliveryId: string;
  conversationId: string;
  itemId: string;
};

type DriverEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "turn_end" }
  | { kind: "error"; message: string };

type SpawnContext = {
  prompt: string;
  remoteAgentId: string;
  serverUrl: string;
  machineKey: string;
  runtimePath?: string;
  workingDirectory: string;
  chatBridgePath: string;
  sessionId?: string;
};

type DriverLaunch = {
  process: ChildProcess;
};

type LogLevel = "error" | "warn" | "info" | "debug";

interface RuntimeDriver {
  readonly runtimeKind: RuntimeKind;
  readonly supportsPersistentSession: boolean;
  spawn(context: SpawnContext): DriverLaunch;
  parseOutputLine(line: string): DriverEvent[];
  encodeWakeMessage?(text: string, sessionId?: string): string | null;
}

type SessionState = {
  sessionId?: string;
};

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_RECONNECT_MS = 3_000;
const MACHINE_DIR_ROOT = path.join(os.homedir(), ".synapse", "remote-agents");
const CHAT_BRIDGE_PATH = fileURLToPath(new URL("./chat-bridge.js", import.meta.url));
const LOG_LEVEL_WEIGHTS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function resolveLogLevel(value?: string): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "error" || normalized === "warn" || normalized === "debug") {
    return normalized;
  }
  return "info";
}

let activeLogLevel = resolveLogLevel(process.env.SYNAPSE_REMOTE_AGENT_LOG_LEVEL);

function shouldLog(level: LogLevel) {
  return LOG_LEVEL_WEIGHTS[level] <= LOG_LEVEL_WEIGHTS[activeLogLevel];
}

function formatLogMeta(meta?: Record<string, unknown>) {
  if (!meta || Object.keys(meta).length === 0) {
    return "";
  }
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return "";
  }
}

function log(
  level: LogLevel,
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (!shouldLog(level)) {
    return;
  }
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}${formatLogMeta(meta)}\n`;
  process.stderr.write(line);
}

function maskSecret(value: string) {
  if (value.length <= 10) {
    return value;
  }
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function parseArgs(argv: string[]): DaemonConfig {
  const args = new Map<string, string>();
  let debug = false;
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current?.startsWith("--")) continue;
    if (current === "--debug") {
      debug = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) continue;
    args.set(current.slice(2), next);
    index += 1;
  }

  const serverUrl = args.get("server-url")?.trim() || "";
  const apiKey = args.get("api-key")?.trim() || "";
  const heartbeatMs = Math.max(
    5_000,
    Number.parseInt(args.get("heartbeat-ms") || "", 10) || DEFAULT_HEARTBEAT_MS,
  );
  const logLevel = debug
    ? "debug"
    : resolveLogLevel(
        args.get("log-level") || process.env.SYNAPSE_REMOTE_AGENT_LOG_LEVEL,
      );

  if (!serverUrl) {
    throw new Error("--server-url is required");
  }
  if (!apiKey) {
    throw new Error("--api-key is required");
  }

  return {
    serverUrl,
    apiKey,
    heartbeatMs,
    logLevel,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDirectory(directory: string) {
  mkdirSync(directory, { recursive: true });
}

function readSessionState(filePath: string): SessionState {
  try {
    if (!existsSync(filePath)) {
      return {};
    }
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as SessionState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSessionState(filePath: string, state: SessionState) {
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
}

function trimFirstLine(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function toWsUrl(serverUrl: string) {
  const url = new URL("/ws/remote-agents", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function buildWakePrompt() {
  return [
    "You have unread Synapse messages.",
    "Call check_messages first.",
    "Then use read_history for the relevant conversation(s), reply with send_message when action is needed, and stop when finished.",
    "If there is nothing actionable, stop without sending any message.",
  ].join(" ");
}

function buildBootstrapPrompt(params: {
  remoteAgentId: string;
  runtimeKind: RuntimeKind;
  workingDirectory: string;
  stateDirectory: string;
}) {
  return [
    `You are a Synapse RemoteAgent running as runtime ${params.runtimeKind}.`,
    `Remote agent id: ${params.remoteAgentId}.`,
    `Primary working directory: ${params.workingDirectory}.`,
    `Persistent session directory: ${params.stateDirectory}.`,
    "",
    "Use the MCP chat tools to communicate with Synapse:",
    "- check_messages",
    "- list_conversations",
    "- read_history",
    "- send_message",
    "- search_messages",
    "",
    "Rules:",
    "- Do not use shell, curl, or custom network requests to talk to Synapse; only use the MCP chat tools.",
    "- This agent can participate in multiple conversations at once.",
    "- Always call check_messages after a wake-up before deciding what to do.",
    "- Read enough history before replying so your response is grounded in the conversation.",
    "- If there is no actionable work, stop without sending a message.",
    "",
    buildWakePrompt(),
  ].join("\n");
}

function splitLines(buffer: string) {
  const parts = buffer.split(/\r?\n/);
  const remainder = parts.pop() ?? "";
  return {
    lines: parts,
    remainder,
  };
}

function previewLine(value: string, maxLength = 280) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function which(binary: string) {
  try {
    const command = process.platform === "win32" ? "where" : "which";
    const output = execSync(`${command} ${binary}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

function detectVersion(command: string, args: string[] = []) {
  try {
    const output = execFileSync(command, [...args, "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    return trimFirstLine(output);
  } catch {
    return undefined;
  }
}

function detectClaudeRuntime(): RuntimeCatalogEntry {
  const explicit = process.env.SYNAPSE_CLAUDE_PATH?.trim();
  const executablePath = explicit || which("claude");
  if (!executablePath) {
    return {
      runtimeKind: "claude_code",
      status: "missing_binary",
    };
  }
  const version = detectVersion(executablePath);
  return {
    runtimeKind: "claude_code",
    executablePath,
    status: "available",
    version,
  };
}

function resolveWindowsCodexEntry() {
  const explicit = process.env.SYNAPSE_CODEX_PATH?.trim();
  if (explicit) {
    return explicit;
  }

  try {
    const globalRoot = execSync("npm root -g", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const candidate = path.join(globalRoot, "@openai", "codex", "bin", "codex.js");
    if (existsSync(candidate)) {
      return candidate;
    }
  } catch {}

  const codexPath = which("codex");
  if (!codexPath) {
    return undefined;
  }
  const fromCmdDir = path.join(
    path.dirname(codexPath),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  if (existsSync(fromCmdDir)) {
    return fromCmdDir;
  }
  return codexPath;
}

function detectCodexRuntime(): RuntimeCatalogEntry {
  const executablePath =
    process.platform === "win32"
      ? resolveWindowsCodexEntry()
      : process.env.SYNAPSE_CODEX_PATH?.trim() || which("codex");

  if (!executablePath) {
    return {
      runtimeKind: "codex",
      status: "missing_binary",
    };
  }

  const version =
    process.platform === "win32" && executablePath.endsWith(".js")
      ? detectVersion(process.execPath, [executablePath])
      : detectVersion(executablePath);

  return {
    runtimeKind: "codex",
    executablePath,
    status: "available",
    version,
  };
}

class ClaudeDriver implements RuntimeDriver {
  readonly runtimeKind = "claude_code" as const;
  readonly supportsPersistentSession = true;

  spawn(context: SpawnContext): DriverLaunch {
    const mcpCommand = process.execPath;
    const mcpArgs = [
      context.chatBridgePath,
      "--remote-agent-id",
      context.remoteAgentId,
      "--server-url",
      context.serverUrl,
      "--machine-key",
      context.machineKey,
    ];

    const mcpConfig = JSON.stringify({
      mcpServers: {
        chat: {
          command: mcpCommand,
          args: mcpArgs,
        },
      },
    });

    let mcpConfigArg = mcpConfig;
    if (process.platform === "win32") {
      const configPath = path.join(
        context.workingDirectory,
        ".synapse-claude-mcp.json",
      );
      writeFileSync(configPath, mcpConfig, "utf8");
      mcpConfigArg = configPath;
    }

    const args = [
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--mcp-config",
      mcpConfigArg,
    ];

    if (context.sessionId) {
      args.push("--resume", context.sessionId);
    }

    const child = spawn(context.runtimePath || "claude", args, {
      cwd: context.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      shell: process.platform === "win32",
    });

    const initialMessage = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: context.prompt }],
      },
      ...(context.sessionId ? { session_id: context.sessionId } : {}),
    });
    child.stdin?.write(`${initialMessage}\n`);

    return { process: child };
  }

  parseOutputLine(line: string) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }

    const events: DriverEvent[] = [];
    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      events.push({ kind: "session", sessionId: String(event.session_id) });
    }
    if (event.type === "result") {
      if (event.is_error && event.stop_reason !== "max_tokens") {
        events.push({
          kind: "error",
          message:
            String(event.result || event.errors?.[0] || "Claude execution failed"),
        });
      }
      events.push({ kind: "turn_end" });
    }
    return events;
  }

  encodeWakeMessage(text: string, sessionId?: string) {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  }
}

class CodexDriver implements RuntimeDriver {
  readonly runtimeKind = "codex" as const;
  readonly supportsPersistentSession = false;

  spawn(context: SpawnContext): DriverLaunch {
    const gitDirectory = path.join(context.workingDirectory, ".git");
    if (!existsSync(gitDirectory)) {
      execSync("git init", {
        cwd: context.workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
      });
      execSync("git add -A && git commit --allow-empty -m \"init\"", {
        cwd: context.workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "synapse",
          GIT_AUTHOR_EMAIL: "synapse@local",
          GIT_COMMITTER_NAME: "synapse",
          GIT_COMMITTER_EMAIL: "synapse@local",
        },
      });
    }

    const bridgeCommand = process.execPath;
    const bridgeArgs = [
      context.chatBridgePath,
      "--remote-agent-id",
      context.remoteAgentId,
      "--server-url",
      context.serverUrl,
      "--machine-key",
      context.machineKey,
    ];

    const args = ["exec"];
    if (context.sessionId) {
      args.push("resume", context.sessionId);
    }
    args.push(
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      "-c",
      `mcp_servers.chat.command=${JSON.stringify(bridgeCommand)}`,
      "-c",
      `mcp_servers.chat.args=${JSON.stringify(bridgeArgs)}`,
      "-c",
      "mcp_servers.chat.startup_timeout_sec=30",
      "-c",
      "mcp_servers.chat.tool_timeout_sec=300",
      "-c",
      "mcp_servers.chat.enabled=true",
      "-c",
      "mcp_servers.chat.required=true",
      context.prompt,
    );

    const runtimePath = context.runtimePath || "codex";
    const isWindowsJsEntry =
      process.platform === "win32" && runtimePath.endsWith(".js");

    const child = isWindowsJsEntry
      ? spawn(process.execPath, [runtimePath, ...args], {
          cwd: context.workingDirectory,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            FORCE_COLOR: "0",
            NO_COLOR: "1",
          },
        })
      : spawn(runtimePath, args, {
          cwd: context.workingDirectory,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            FORCE_COLOR: "0",
            NO_COLOR: "1",
          },
          shell: process.platform === "win32",
        });

    return { process: child };
  }

  parseOutputLine(line: string) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }

    const events: DriverEvent[] = [];
    switch (event.type) {
      case "thread.started":
        if (event.thread_id) {
          events.push({ kind: "session", sessionId: String(event.thread_id) });
        }
        break;
      case "turn.completed":
        events.push({ kind: "turn_end" });
        break;
      case "turn.failed":
        events.push({
          kind: "error",
          message: String(event.error?.message || "Codex execution failed"),
        });
        events.push({ kind: "turn_end" });
        break;
      case "error":
        events.push({
          kind: "error",
          message: String(event.message || "Codex execution failed"),
        });
        break;
      default:
        break;
    }
    return events;
  }
}

function createDriver(runtimeKind: RuntimeKind): RuntimeDriver {
  return runtimeKind === "claude_code"
    ? new ClaudeDriver()
    : new CodexDriver();
}

class DaemonSupervisor {
  private ws: WebSocket | null = null;

  private readonly agents = new Map<string, ManagedRemoteAgent>();

  private machineId: string | null = null;

  constructor(private readonly config: DaemonConfig) {}

  async run() {
    log("info", "daemon", "Starting remote-agent daemon", {
      serverUrl: this.config.serverUrl,
      apiKey: maskSecret(this.config.apiKey),
      heartbeatMs: this.config.heartbeatMs,
      logLevel: activeLogLevel,
    });
    for (;;) {
      try {
        await this.connectOnce();
      } catch (error) {
        log("error", "daemon", "WebSocket loop failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      log("warn", "daemon", "Disconnected from server, retrying", {
        retryInMs: DEFAULT_RECONNECT_MS,
      });
      await sleep(DEFAULT_RECONNECT_MS);
    }
  }

  send(payload: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  private async connectOnce() {
    const wsUrl = toWsUrl(this.config.serverUrl);
    wsUrl.searchParams.set("key", this.config.apiKey);
    log("info", "daemon", "Connecting to server", {
      url: wsUrl.toString().replace(this.config.apiKey, maskSecret(this.config.apiKey)),
    });

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      let heartbeatTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        this.ws = null;
      };

      ws.once("open", () => {
        log("info", "daemon", "WebSocket connected");
        heartbeatTimer = setInterval(() => {
          this.send({ type: "heartbeat" });
        }, this.config.heartbeatMs);
      });

      ws.once("error", (error) => {
        log("error", "daemon", "WebSocket error", {
          error: error.message,
        });
        cleanup();
        reject(error);
      });

      ws.on("message", async (raw) => {
        let message: any;
        try {
          message = JSON.parse(String(raw));
        } catch {
          return;
        }

        if (message?.type === "connected") {
          const connected = message as ConnectedMessage;
          this.machineId = connected.machineId;
          const runtimeCatalog = [detectClaudeRuntime(), detectCodexRuntime()];
          log("info", "daemon", "Server accepted machine session", {
            machineId: connected.machineId,
            sessionId: connected.sessionId,
          });
          log("info", "daemon", "Runtime catalog detected", {
            runtimeCatalog,
          });
          this.send({
            type: "ready",
            runtimeCatalog,
          });
          log("debug", "daemon", "Sent ready payload", {
            runtimeCount: runtimeCatalog.length,
          });
          return;
        }

        if (message?.type === "pong") {
          log("debug", "daemon", "Received heartbeat pong");
          return;
        }

        if (message?.type === "agent:start") {
          const start = message as AgentStartMessage;
          log("info", `remote-agent:${start.remoteAgentId}`, "Received agent:start", {
            runtimeKind: start.runtimeKind,
            runtimePath: start.runtimePath ?? undefined,
            localRootPath: start.localRootPath ?? undefined,
            sessionId: start.sessionId ?? undefined,
          });
          const agent = this.getOrCreateAgent(start.remoteAgentId);
          await agent.configure(start);
          return;
        }

        if (message?.type === "agent:stop" && typeof message.remoteAgentId === "string") {
          log("info", `remote-agent:${message.remoteAgentId}`, "Received agent:stop");
          const agent = this.agents.get(message.remoteAgentId);
          if (agent) {
            agent.stop("server stop");
          }
          return;
        }

        if (message?.type === "agent:deliver") {
          const deliver = message as DeliveryMessage;
          const grouped = new Map<string, Delivery[]>();
          for (const delivery of deliver.deliveries ?? []) {
            const bucket = grouped.get(delivery.remoteAgentId) ?? [];
            bucket.push(delivery);
            grouped.set(delivery.remoteAgentId, bucket);
          }
          for (const [remoteAgentId, deliveries] of grouped) {
            log("info", `remote-agent:${remoteAgentId}`, "Received message deliveries", {
              count: deliveries.length,
              conversationIds: [...new Set(deliveries.map((delivery) => delivery.conversationId))],
            });
            const agent = this.getOrCreateAgent(remoteAgentId);
            await agent.enqueueDeliveries(deliveries);
          }
          return;
        }
      });

      ws.once("close", () => {
        log("warn", "daemon", "WebSocket closed");
        cleanup();
        resolve();
      });
    });
  }

  private getOrCreateAgent(remoteAgentId: string) {
    let agent = this.agents.get(remoteAgentId);
    if (!agent) {
      agent = new ManagedRemoteAgent({
        remoteAgentId,
        daemon: this,
        config: this.config,
        getMachineId: () => this.machineId,
      });
      this.agents.set(remoteAgentId, agent);
    }
    return agent;
  }
}

class ManagedRemoteAgent {
  private runtimeKind: RuntimeKind = "claude_code";

  private runtimePath?: string;

  private localRootPath?: string;

  private sessionId?: string;

  private process: ChildProcess | null = null;

  private stdoutBuffer = "";

  private stderrBuffer = "";

  private running = false;

  private pendingWake = false;

  private readonly pendingDeliveryIds = new Set<string>();

  private readonly pendingDeliveries: Delivery[] = [];

  private stateDirectory = "";

  private stateFile = "";

  constructor(private readonly params: {
    remoteAgentId: string;
    daemon: DaemonSupervisor;
    config: DaemonConfig;
    getMachineId: () => string | null;
  }) {}

  async configure(message: AgentStartMessage) {
    this.runtimeKind = message.runtimeKind;
    this.runtimePath = message.runtimePath ?? undefined;
    this.localRootPath = message.localRootPath ?? undefined;

    const machineId = this.params.getMachineId();
    if (!machineId) {
      throw new Error("Machine id is not ready");
    }

    this.stateDirectory = path.join(
      MACHINE_DIR_ROOT,
      machineId,
      this.params.remoteAgentId,
    );
    this.stateFile = path.join(this.stateDirectory, "session.json");
    ensureDirectory(this.stateDirectory);
    ensureDirectory(path.join(this.stateDirectory, "notes"));
    if (!existsSync(path.join(this.stateDirectory, "MEMORY.md"))) {
      writeFileSync(path.join(this.stateDirectory, "MEMORY.md"), "", "utf8");
    }

    const workingDirectory =
      this.localRootPath ||
      path.join(this.stateDirectory, "workspace");
    ensureDirectory(workingDirectory);

    const storedState = readSessionState(this.stateFile);
    this.sessionId =
      message.sessionId ??
      storedState.sessionId ??
      this.sessionId;
    log("info", `remote-agent:${this.params.remoteAgentId}`, "Configured remote agent", {
      runtimeKind: this.runtimeKind,
      runtimePath: this.runtimePath ?? undefined,
      localRootPath: this.localRootPath ?? undefined,
      stateDirectory: this.stateDirectory,
      sessionId: this.sessionId ?? undefined,
    });
  }

  stop(reason: string) {
    if (this.process && (this.process.exitCode === null || this.process.killed === false)) {
      this.process.kill();
    }
    this.process = null;
    this.running = false;
    this.pendingWake = false;
    log("warn", `remote-agent:${this.params.remoteAgentId}`, "Stopped remote agent", {
      reason,
    });
  }

  async enqueueDeliveries(deliveries: Delivery[]) {
    for (const delivery of deliveries) {
      if (this.pendingDeliveryIds.has(delivery.deliveryId)) continue;
      this.pendingDeliveryIds.add(delivery.deliveryId);
      this.pendingDeliveries.push(delivery);
    }
    log("debug", `remote-agent:${this.params.remoteAgentId}`, "Queued deliveries", {
      pendingCount: this.pendingDeliveries.length,
    });
    await this.wake();
  }

  private workingDirectory() {
    return this.localRootPath || path.join(this.stateDirectory, "workspace");
  }

  private persistSession() {
    if (!this.stateFile) return;
    writeSessionState(this.stateFile, {
      sessionId: this.sessionId,
    });
  }

  private async wake() {
    if (!this.stateDirectory) {
      return;
    }

    const driver = createDriver(this.runtimeKind);
    if (
      driver.supportsPersistentSession &&
      this.process &&
      !this.running &&
      typeof driver.encodeWakeMessage === "function"
    ) {
      const wakeMessage = driver.encodeWakeMessage(
        buildWakePrompt(),
        this.sessionId,
      );
      if (wakeMessage && this.process.stdin?.writable) {
        this.pendingDeliveries.length = 0;
        this.pendingDeliveryIds.clear();
        this.running = true;
        this.pendingWake = false;
        log("info", `remote-agent:${this.params.remoteAgentId}`, "Waking persistent session", {
          sessionId: this.sessionId ?? undefined,
        });
        this.process.stdin.write(`${wakeMessage}\n`);
        return;
      }
    }

    if (this.running || this.pendingWake) {
      return;
    }

    this.pendingWake = true;
    log("debug", `remote-agent:${this.params.remoteAgentId}`, "Scheduling new run", {
      sessionId: this.sessionId ?? undefined,
    });
    this.startRun();
  }

  private startRun() {
    this.pendingWake = false;
    this.running = true;
    this.pendingDeliveries.length = 0;
    this.pendingDeliveryIds.clear();
    const driver = createDriver(this.runtimeKind);
    const prompt = buildBootstrapPrompt({
      remoteAgentId: this.params.remoteAgentId,
      runtimeKind: this.runtimeKind,
      workingDirectory: this.workingDirectory(),
      stateDirectory: this.stateDirectory,
    });

    let launch: DriverLaunch;
    try {
      log("info", `remote-agent:${this.params.remoteAgentId}`, "Starting local runtime", {
        runtimeKind: this.runtimeKind,
        runtimePath: this.runtimePath ?? undefined,
        workingDirectory: this.workingDirectory(),
        sessionId: this.sessionId ?? undefined,
      });
      launch = driver.spawn({
        prompt,
        remoteAgentId: this.params.remoteAgentId,
        serverUrl: this.params.config.serverUrl,
        machineKey: this.params.config.apiKey,
        runtimePath: this.runtimePath,
        workingDirectory: this.workingDirectory(),
        chatBridgePath: CHAT_BRIDGE_PATH,
        sessionId: this.sessionId,
      });
    } catch (error) {
      this.running = false;
      log("error", `remote-agent:${this.params.remoteAgentId}`, "Failed to start local runtime", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    this.process = launch.process;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    launch.process.stdout?.on("data", (chunk: Buffer | string) => {
      this.stdoutBuffer += String(chunk);
      const { lines, remainder } = splitLines(this.stdoutBuffer);
      this.stdoutBuffer = remainder;
      for (const line of lines) {
        const preview = previewLine(line);
        if (preview) {
          log("debug", `remote-agent:${this.params.remoteAgentId}`, "Runtime stdout", {
            preview,
          });
        }
        for (const event of driver.parseOutputLine(line)) {
          this.handleDriverEvent(event);
        }
      }
    });

    launch.process.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      this.stderrBuffer += text;
      if (text.includes("No conversation found with session ID")) {
        this.sessionId = undefined;
        this.persistSession();
      }
      const preview = trimFirstLine(text);
      if (preview) {
        log("warn", `remote-agent:${this.params.remoteAgentId}`, "Runtime stderr", {
          preview,
        });
      }
    });

    launch.process.once("exit", (code, signal) => {
      this.process = null;
      const driverForExit = createDriver(this.runtimeKind);
      if (!driverForExit.supportsPersistentSession) {
        this.running = false;
      }
      log("info", `remote-agent:${this.params.remoteAgentId}`, "Runtime process exited", {
        code: code ?? undefined,
        signal: signal ?? undefined,
        sessionId: this.sessionId ?? undefined,
      });
      if (this.pendingDeliveries.length > 0) {
        void this.wake();
      }
    });
  }

  private handleDriverEvent(event: DriverEvent) {
    switch (event.kind) {
      case "session":
        if (this.sessionId !== event.sessionId) {
          this.sessionId = event.sessionId;
          this.persistSession();
          log("info", `remote-agent:${this.params.remoteAgentId}`, "Session updated", {
            sessionId: event.sessionId,
          });
          this.params.daemon.send({
            type: "agent:session",
            remoteAgentId: this.params.remoteAgentId,
            sessionId: event.sessionId,
          });
        }
        break;
      case "error":
        log("error", `remote-agent:${this.params.remoteAgentId}`, "Runtime event error", {
          message: event.message,
        });
        break;
      case "turn_end":
        this.running = false;
        log("debug", `remote-agent:${this.params.remoteAgentId}`, "Runtime turn completed", {
          pendingCount: this.pendingDeliveries.length,
        });
        if (this.pendingDeliveries.length > 0) {
          void this.wake();
        }
        break;
      default:
        break;
    }
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  activeLogLevel = config.logLevel;
  ensureDirectory(MACHINE_DIR_ROOT);
  const supervisor = new DaemonSupervisor(config);
  await supervisor.run();
}

main().catch((error) => {
  log(
    "error",
    "daemon",
    "Daemon crashed",
    {
      error: error instanceof Error ? error.stack || error.message : String(error),
    },
  );
  process.exit(1);
});
