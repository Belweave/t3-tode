/**
 * Backend lifecycle for t3-tode.
 *
 * Launches the official T3 Code backend + web frontend — the `t3` server from
 * the npm package `t3` — as a child process bound to loopback, waits until it
 * answers HTTP, and hands back the URL a client can load. The server itself
 * serves the full web app at `/` on the same origin as `/api` and `/ws`, so
 * the returned URL gives complete feature parity with the browser client.
 * To attach to an already-running server instead of launching one, use
 * `validateUrl` on the user-supplied `--url` value.
 *
 * CLI facts this module relies on (verified against vendor/t3code, npm `t3`
 * 0.0.45):
 *   - `t3 [flags] [cwd]` runs the server in "web" mode.
 *   - `--host` defaults to loopback; `--host 127.0.0.1` is passed explicitly
 *     so the backend can never end up on a shareable interface.
 *   - `--port` pins the port; without it the server picks a free port starting
 *     at 3773 and records the real one in `<base-dir>/userdata/server-runtime.json`.
 *   - `--base-dir <dir>` is the T3 home directory; runtime state lives under
 *     `<dir>/userdata`.
 *   - `--no-browser` stops the server from opening the user's browser.
 *   - During startup the server logs a pairing URL (web mode) and writes the
 *     runtime state file once HTTP is listening; both are consumed here.
 *
 * This module must stay dependency-free and runnable on Node >= 22.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * The npm `t3` release this module is developed and tested against. The
 * package itself is managed by the parent (do not add it to package.json
 * here); when `t3` is not on PATH the default launch command falls back to
 * `npx t3@<this version>`.
 */
export const RECOMMENDED_T3_VERSION = "0.0.45";

const READY_POLL_MS = 250;
const PROBE_TIMEOUT_MS = 2_000;
const PREFLIGHT_TIMEOUT_MS = 750;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_GRACE_MS = 8_000;
const LOG_RING_LIMIT = 200;
const LOG_TAIL_LINES = 40;
const STARTED_AT_CLOCK_SKEW_MS = 5_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Error thrown for backend lifecycle failures. `code` is machine-readable. */
export class BackendError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "BackendError";
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    /** Last captured backend log lines, for surfacing alongside the message. */
    this.logTail = options.logTail;
  }
}

/**
 * True when a URL hostname refers to this machine's loopback. Mirrors the
 * t3 server's own notion (`127.*`, `localhost`, `::1`).
 */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== "string") return false;
  const normalized = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" || normalized === "::1" || /^127\./.test(normalized);
}

/**
 * Validate a URL for the attach (`--url`) path. Requires an explicit http/https URL. Local and remote servers are supported. Path,
 * query and hash are preserved so pairing URLs (`/pair#token=...`) survive.
 * Returns the parsed URL; throws `TypeError` with a user-facing message.
 */
export function validateUrl(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new TypeError("A URL is required, for example http://127.0.0.1:3773");
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new TypeError("Not a valid HTTP(S) server URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(
      `Only http and https URLs are supported, got "${url.protocol.replace(":", "")}:"`,
    );
  }
  return url;
}

/** Redact pairing credentials before storing backend output. */
export function redactLog(line) {
  return line.replace(/([#?]token=)[^\s"'<>]+/gi, '$1[redacted]')
    .replace(/(\b(?:credential|bootstrapToken|bearerToken)\s*[:=]\s*)[^\s",}]+/gi, '$1[redacted]');
}

/** Expand a leading `~/` like the t3 CLI does. */
function expandHome(input) {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * Build the t3 server arguments. Loopback-only by construction: `--host
 * 127.0.0.1` is always included and no host option exists. The `cwd`
 * positional goes last because it is an argument, not a flag.
 */
export function serverArgs({ cwd, port, stateDir } = {}) {
  const args = ["--mode", "web", "--no-browser", "--host", "127.0.0.1"];
  if (port !== undefined && port !== null) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError(`port must be an integer between 1 and 65535, got ${port}`);
    }
    args.push("--port", String(port));
  }
  if (stateDir !== undefined && stateDir !== null) {
    if (typeof stateDir !== "string" || stateDir.trim() === "") {
      throw new TypeError("stateDir must be a non-empty string");
    }
    args.push("--base-dir", path.resolve(expandHome(stateDir)));
  }
  if (cwd !== undefined && cwd !== null) {
    if (typeof cwd !== "string" || cwd.trim() === "") {
      throw new TypeError("cwd must be a non-empty string");
    }
    args.push(path.resolve(expandHome(cwd)));
  }
  return args;
}

/**
 * Find a `t3` executable on PATH (the standalone binary installed by the
 * t3 installer or the npm global shim). Returns the absolute path or null.
 * `env` is injectable for tests.
 */
export function findT3OnPath(env = process.env) {
  const pathVar = env.PATH ?? env.Path ?? "";
  const dirs = pathVar.split(path.delimiter).filter((dir) => dir.length > 0);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `t3${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/**
 * Normalize the `command` option into { program, baseArgs }.
 *   - undefined  → `t3` from PATH, else `npx t3@<RECOMMENDED_T3_VERSION>`
 *   - string     → a single program path or name (no argument parsing)
 *   - string[]   → program plus leading arguments, our flags are appended after
 */
export function normalizeCommand(command = undefined, env = process.env) {
  if (command === undefined || command === null) {
    const found = findT3OnPath(env);
    if (found) return { program: found, baseArgs: [] };
    return {
      program: process.platform === "win32" ? "npx.cmd" : "npx",
      baseArgs: ["t3@" + RECOMMENDED_T3_VERSION],
    };
  }
  if (typeof command === "string") {
    if (command.trim() === "") throw new TypeError("command must not be empty");
    return { program: command, baseArgs: [] };
  }
  if (Array.isArray(command)) {
    if (command.length === 0 || typeof command[0] !== "string" || command[0].trim() === "") {
      throw new TypeError("command array must start with a non-empty program string");
    }
    return {
      program: command[0],
      baseArgs: command.slice(1).map((part) => {
        if (typeof part !== "string") throw new TypeError("command array elements must be strings");
        return part;
      }),
    };
  }
  throw new TypeError("command must be a string, a string array, or undefined");
}

/** T3 home directory implied by the options and environment. */
function resolveBaseDir(stateDir) {
  if (stateDir !== undefined && stateDir !== null) return path.resolve(expandHome(stateDir));
  return path.join(os.homedir(), ".local", "share", "t3-tode", "backend");
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether anything accepts TCP connections on 127.0.0.1:port. */
function tcpOpen(port, timeoutMs = PREFLIGHT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/**
 * One bounded HTTP readiness probe. Any response at all — including 4xx/5xx —
 * proves the t3 HTTP listener is up and serving; app-level health is the
 * client's concern.
 */
function probeHttp(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/", agent: false, timeout: timeoutMs },
      (response) => {
        response.resume(); // drain and release the socket
        resolve(true);
      },
    );
    request.on("timeout", () => request.destroy(new Error("probe timed out")));
    request.on("error", () => resolve(false));
  });
}

/**
 * Read and validate the runtime state file the t3 server writes once its HTTP
 * listener is up (`<base-dir>/userdata/server-runtime.json`). Returns null
 * while absent, stale (dead pid or older than this launch), or unusable.
 */
async function readRuntimeState(stateFile, launchedAtWallMs) {
  let raw;
  try {
    raw = await fs.promises.readFile(stateFile, "utf8");
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || data.version !== 1) return null;
  const port = data.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (data.host !== undefined && data.host !== null && !isLoopbackHostname(data.host)) return null;
  if (!Number.isInteger(data.pid) || !isProcessAlive(data.pid)) return null;
  const startedAt = Date.parse(data.startedAt);
  if (!Number.isFinite(startedAt) || startedAt < launchedAtWallMs - STARTED_AT_CLOCK_SKEW_MS) {
    return null;
  }
  return data;
}

/** Split a byte stream into lines and hand each to `onLine`. */
function pumpLines(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newlineAt = buffer.indexOf("\n");
      if (newlineAt === -1) break;
      onLine(buffer.slice(0, newlineAt).replace(/\r$/, ""));
      buffer = buffer.slice(newlineAt + 1);
    }
    if (buffer.length > 1_000_000) {
      onLine(buffer);
      buffer = "";
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) onLine(buffer.replace(/\r$/, ""));
    buffer = "";
  });
  stream.on("error", () => {});
}

/**
 * Signal the backend's whole process tree. The child is spawned detached, so
 * on POSIX the negative pid targets its process group and takes out the npm
 * wrapper, the platform binary, and any provider CLIs they spawned. On
 * Windows `taskkill /T` does the equivalent.
 */
function signalTree(pid, signal, child) {
  if (process.platform === "win32" && signal !== "SIGKILL") {
    // Windows has no group signals; forceful termination happens below.
    return;
  }
  try {
    if (process.platform === "win32") {
      child?.kill("SIGKILL");
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    if (error?.code === "ESRCH") return; // already gone
    try {
      child?.kill(signal);
    } catch {
      // nothing more we can do
    }
  }
}

function processGroupAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {process.kill(-pid, 0); return true;} catch (error) {return error.code === 'EPERM';}
}

async function waitForGroupGone(pid, deadline) {
  while (processGroupAlive(pid) && Date.now() < deadline) await sleep(50);
  return !processGroupAlive(pid);
}

async function taskkillTree(pid) {
  if (process.platform !== "win32") return;
  const { execFile } = await import("node:child_process");
  await new Promise((resolve) => {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

/** Wait until the direct child process exits, or the grace period runs out. */
async function waitForExit(graceMs, exitInfo) {
  let timer;
  try {
    const result = await Promise.race([exitInfo.promise, new Promise(resolve => {timer = setTimeout(() => resolve(null), graceMs);})]);
    return result !== null;
  } finally {clearTimeout(timer);}
}

/**
 * Launch the T3 Code backend (server + web frontend) and wait until it
 * answers HTTP on loopback.
 *
 * @param {object} options
 * @param {string} [options.cwd] Project directory passed to the server as its
 *   positional `cwd` (working directory for provider sessions); also used as
 *   the child process working directory when it already exists.
 * @param {number} [options.port] Port to bind. Omit to let the server pick a
 *   free one starting at 3773; the actual port is discovered from the
 *   server's runtime state file.
 * @param {string} [options.stateDir] T3 home directory, passed as
 *   `--base-dir`. Runtime state lives under `<stateDir>/userdata`. Omit to
 *   use t3-tode's isolated home (`~/.local/share/t3-tode/backend`).
 * @param {string|string[]} [options.command] Launch command override. A
 *   string is a single program path/name; an array is `["t3", ...extraArgs]`
 *   with the server flags appended after. Defaults to `t3` from PATH, else
 *   `npx t3@<RECOMMENDED_T3_VERSION>`.
 * @param {number} [options.readyTimeoutMs] Overall startup deadline.
 * @param {number} [options.stopGraceMs] SIGTERM→SIGKILL grace for `stop()`.
 * @param {(line: string, source: "stdout"|"stderr"|"t3-tode") => void} [options.onLog]
 *   Called for every captured log line.
 * @param {object} [options.env] Extra environment variables for the child,
 *   merged over the parent's environment.
 * @returns {Promise<{url: string, stop: () => Promise<void>, pid: number,
 *   logFile: string}>} `url` is the loopback origin serving the full web app.
 *   `stop()` terminates the process tree (idempotent, safe after crashes).
 *   `pid` is the direct child process id; `logFile` is the captured log.
 * @throws {BackendError} `PORT_IN_USE` (explicit port taken before launch),
 *   `SPAWN_ERROR`, `START_EXITED` (server died during startup), or `TIMEOUT`.
 *   All carry a `logTail` with the last captured log lines.
 *
 * A safety net force-kills the backend if this process exits without
 * `stop()` having been called; wire SIGINT/SIGTERM to `stop()` in the caller
 * for a graceful shutdown.
 */
export async function startBackend(options = {}) {
  const {
    cwd,
    port,
    stateDir,
    command,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    onLog,
    signal,
    env: extraEnv,
  } = options;
  if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
    throw new TypeError("readyTimeoutMs must be a positive number");
  }
  if (!Number.isFinite(stopGraceMs) || stopGraceMs <= 0) {
    throw new TypeError("stopGraceMs must be a positive number");
  }
  if (onLog !== undefined && typeof onLog !== "function") {
    throw new TypeError("onLog must be a function");
  }
  if (extraEnv !== undefined && (extraEnv === null || typeof extraEnv !== "object")) {
    throw new TypeError("env must be an object of extra environment variables");
  }

  signal?.throwIfAborted();
  // Validation happens before anything is spawned.
  const { program, baseArgs } = normalizeCommand(command);
  const baseDir = resolveBaseDir(stateDir);
  const args = serverArgs({ cwd, port, stateDir: baseDir });
  const explicitPort = port !== undefined && port !== null ? port : undefined;
  const runtimeStateFile = path.join(baseDir, "userdata", "server-runtime.json");
  const logFile = path.join(baseDir, "userdata", "logs", "t3-tode-backend.log");
  await fs.promises.mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });

  // Keep one previous log so persisted diagnostics stay bounded across runs.
  // Rotation is synchronous with writes below, avoiding overlapping streams
  // when a busy backend crosses the size limit.
  let logBytes = 0;
  try { logBytes = fs.statSync(logFile).size; } catch {}
  if (logBytes >= MAX_LOG_BYTES) {
    try { fs.unlinkSync(`${logFile}.1`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { fs.renameSync(logFile, `${logFile}.1`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try {
      const priorSize = fs.statSync(`${logFile}.1`).size;
      if (priorSize > MAX_LOG_BYTES) {
        const fd = fs.openSync(`${logFile}.1`, "r+");
        try {
          const tail = Buffer.alloc(MAX_LOG_BYTES);
          fs.readSync(fd, tail, 0, MAX_LOG_BYTES, priorSize - MAX_LOG_BYTES);
          fs.ftruncateSync(fd, 0);
          fs.writeSync(fd, tail, 0, tail.length, 0);
        } finally { fs.closeSync(fd); }
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    logBytes = 0;
  }

  if (explicitPort !== undefined && (await tcpOpen(explicitPort))) {
    throw new BackendError(
      `Port ${explicitPort} is already in use on 127.0.0.1. ` +
        `Attach to the running server with its URL instead of launching a new one.`,
      { code: "PORT_IN_USE" },
    );
  }

  const ring = [];
  const writeLog = (rawLine, source) => {
    // The launcher consumes the one-time link in memory; disk and error tails never retain it.
    const line = redactLog(rawLine);
    ring.push({ line, source });
    if (ring.length > LOG_RING_LIMIT) ring.shift();
    let record = Buffer.from(`${new Date().toISOString()} [${source}] ${line}\n`);
    if (record.length > MAX_LOG_BYTES) record = record.subarray(0, MAX_LOG_BYTES);
    if (logBytes + record.length > MAX_LOG_BYTES) {
      try { fs.unlinkSync(`${logFile}.1`); } catch (error) { if (error.code !== "ENOENT") return; }
      try { fs.renameSync(logFile, `${logFile}.1`); } catch (error) { if (error.code !== "ENOENT") return; }
      logBytes = 0;
    }
    try {
      fs.appendFileSync(logFile, record, { mode: 0o600 });
      logBytes += record.length;
    } catch {
      // Logging failures must not interrupt backend lifecycle handling.
    }
    if (onLog) {
      try {
        onLog(rawLine, source);
      } catch {
        // a broken consumer must not break the backend
      }
    }
  };
  const log = (line) => writeLog(line, "t3-tode");
  const logTail = () =>
    ring
      .slice(-LOG_TAIL_LINES)
      .map((entry) => (entry.source === "t3-tode" ? entry.line : `[${entry.source}] ${entry.line}`))
      .join("\n");

  log(`== t3-tode backend launch ${new Date().toISOString()} ==`);
  log(`command: ${program} ${[...baseArgs, ...args].join(" ")}`);

  const cwdAbs = cwd ? path.resolve(expandHome(cwd)) : undefined;
  const child = spawn(program, [...baseArgs, ...args], {
    cwd: cwdAbs !== undefined && fs.existsSync(cwdAbs) ? cwdAbs : undefined,
    env: { ...process.env, ...(extraEnv ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so the whole tree can be signalled (see signalTree).
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  pumpLines(child.stdout, (line) => line.length > 0 && writeLog(line, "stdout"));
  pumpLines(child.stderr, (line) => line.length > 0 && writeLog(line, "stderr"));

  const exitInfo = {};
  exitInfo.promise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitInfo.code = code;
      exitInfo.signal = signal;
      exitInfo.settled = true;
      resolve({ code, signal });
    });
  });
  child.once("error", (error) => {
    if (exitInfo.settled) return;
    exitInfo.spawnError = error;
  });

  // Safety net: if this process exits without stop(), take the backend down.
  const pid = child.pid;
  const exitHook = () => {
    if (process.platform === "win32") {
      try {
        child.kill("SIGKILL");
      } catch {}
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  };
  process.on("exit", exitHook);

  let stopped = false;
  const cleanupAfterStop = async () => {
    process.removeListener("exit", exitHook);
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // Direct wrappers can exit before their children; own the entire process group.
    if (!exitInfo.spawnError) {
      if (process.platform === "win32") {
        await taskkillTree(pid);
      } else {
        const deadline = Date.now() + stopGraceMs;
        signalTree(pid, "SIGTERM", child);
        await waitForExit(stopGraceMs, exitInfo);
        if (!await waitForGroupGone(pid, deadline)) signalTree(pid, "SIGKILL", child);
        if (!exitInfo.settled) await waitForExit(stopGraceMs, exitInfo);
      }
    }
    await cleanupAfterStop();
  };

  const fail = async (error) => {
    // Never leave a half-started backend behind on a failed launch.
    stopped = true;
    if (!exitInfo.spawnError) {
      try {
        if (process.platform === "win32") await taskkillTree(pid);
        else signalTree(pid, "SIGKILL", child);
        if (!exitInfo.settled) await waitForExit(stopGraceMs, exitInfo);
      } catch {}
    }
    await cleanupAfterStop().catch(() => {});
    error.pid = pid;
    error.logTail = error.logTail ?? logTail();
    throw error;
  };

  try {
    const deadline = Date.now() + readyTimeoutMs;
    const launchedAtWallMs = Date.now();
    let boundPort = explicitPort;

    for (;;) {
      if (signal?.aborted) await fail(new BackendError("Backend startup was interrupted", {code:"ABORTED"}));
      if (exitInfo.settled || exitInfo.spawnError) {
        const detail = exitInfo.spawnError
          ? `failed to spawn "${program}": ${exitInfo.spawnError.message}`
          : `exited with ${exitInfo.code !== null ? `code ${exitInfo.code}` : `signal ${exitInfo.signal}`}`;
        await fail(
          new BackendError(`The t3 backend ${detail} during startup.`, {
            code: exitInfo.spawnError ? "SPAWN_ERROR" : "START_EXITED",
            exitCode: exitInfo.code,
            signal: exitInfo.signal,
            logTail: logTail(),
          }),
        );
      }
      if (boundPort === undefined) {
        const state = await readRuntimeState(runtimeStateFile, launchedAtWallMs);
        if (state) boundPort = state.port;
      }
      if (boundPort !== undefined && (await probeHttp(boundPort))) break;
      if (Date.now() >= deadline) {
        const discoveryHint =
          explicitPort === undefined
            ? " No port was requested and the server's runtime state file never reported one " +
              `(looked for ${runtimeStateFile}); pass an explicit port to skip discovery.`
            : "";
        await fail(
          new BackendError(
            `The t3 backend did not become ready on 127.0.0.1` +
              (boundPort !== undefined ? `:${boundPort}` : "") +
              ` within ${Math.round(readyTimeoutMs / 1000)}s.${discoveryHint}`,
            { code: "TIMEOUT", logTail: logTail() },
          ),
        );
      }
      await sleep(READY_POLL_MS);
    }

    log(`ready on http://127.0.0.1:${boundPort}`);
    return { url: `http://127.0.0.1:${boundPort}/`, stop, pid, logFile };
  } catch (error) {
    if (error instanceof BackendError) throw error;
    await fail(
      new BackendError(`Starting the t3 backend failed: ${error?.message ?? String(error)}`, {
        logTail: logTail(),
      }),
    );
  }
}
