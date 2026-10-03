import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const DEFAULTS = { sshPort: 22, remotePort: 3773, remoteStateDir: "~/.t3", remoteCommand: "t3", remoteStart: false };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function validPort(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new TypeError(`${name} must be an integer between 1 and 65535`);
}
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function remotePath(value) {
  if (value === "~") return '"$HOME"';
  if (value.startsWith("~/")) return `"$HOME"/${shellQuote(value.slice(2))}`;
  return shellQuote(value);
}
function validate(args) {
  if (!args || typeof args !== "object") throw new TypeError("options are required");
  if (typeof args.ssh !== "string" || !args.ssh.trim() || args.ssh.startsWith("-")) throw new TypeError("ssh must be a host or SSH config alias");
  const opts = { ...DEFAULTS, ...args };
  validPort(opts.sshPort, "sshPort"); validPort(opts.remotePort, "remotePort");
  if (opts.identity !== undefined && (typeof opts.identity !== "string" || !opts.identity)) throw new TypeError("identity must be a non-empty path");
  if (typeof opts.remoteStateDir !== "string" || !opts.remoteStateDir) throw new TypeError("remoteStateDir must be a non-empty path");
  if (typeof opts.remoteCommand !== "string" || !opts.remoteCommand || /[\s\0]/.test(opts.remoteCommand)) throw new TypeError("remoteCommand must be an executable path, not a shell fragment");
  if (typeof opts.remoteStart !== "boolean") throw new TypeError("remoteStart must be a boolean");
  return opts;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close((error) => error ? reject(error) : resolve(port)); });
  });
}
function request(port, pathname, timeout = 1200) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, agent: false, timeout }, (res) => {
      const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("timeout", () => req.destroy(new Error("HTTP probe timed out")));
    req.once("error", reject);
  });
}
function redact(text) { return String(text).replace(/([#?]token=)[^\s"'<>]+/gi, "$1[redacted]").replace(/(credential\s*[:=]\s*)[^\s",}]+/gi, "$1[redacted]"); }

/** Create an SSH loopback forward to a remote T3 server and mint a local pairing URL. */
export async function connectSsh(input) {
  const opts = validate(input);
  const sshBin = input.sshCommand ?? "ssh";
  const baseArgs = ["-p", String(opts.sshPort), "-o", "ExitOnForwardFailure=yes"];
  if (opts.identity) baseArgs.push("-i", opts.identity);
  const signal = opts.signal;
  if (signal?.aborted) throw signal.reason ?? new Error("SSH connection aborted");
  const port = await reservePort();
  let child;
  let stderr = "";
  let stopped = false;
  let exitInfo;
  const exited = new Promise((resolve) => {
    child = spawn(sshBin, [...baseArgs, "-N", "-L", `127.0.0.1:${port}:127.0.0.1:${opts.remotePort}`, opts.ssh], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-6000); });
    child.once("error", (error) => { exitInfo = error; resolve(error); });
    child.once("exit", (code, sig) => { exitInfo = new Error(`SSH tunnel exited (${code ?? sig})`); resolve(exitInfo); });
  });
  const stop = async () => {
    if (stopped) return; stopped = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(1500)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  };
  const abort = () => { void stop(); };
  signal?.addEventListener("abort", abort, { once: true });
  const fail = async (error) => { await stop(); signal?.removeEventListener("abort", abort); throw error; };
  try {
    const deadline = Date.now() + (input.readyTimeoutMs ?? 30_000);
    let ready = false;
    const stateDir = remotePath(opts.remoteStateDir);
    const launch = `mkdir -p ${stateDir} && (nohup ${shellQuote(opts.remoteCommand)} serve --headless --base-dir ${stateDir} --host 127.0.0.1 --port ${opts.remotePort} >/dev/null 2>&1 </dev/null &)`;
    let startIssued = false;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("SSH connection aborted");
      if (exitInfo) throw new Error(`SSH tunnel failed: ${redact(stderr.trim() || exitInfo.message)}`);
      try {
        const env = await request(port, "/.well-known/t3/environment", 750);
        if (env.status >= 200 && env.status < 300) { ready = true; break; }
      } catch { /* tunnel is still starting */ }
      if (opts.remoteStart && !startIssued) {
        startIssued = true;
        await new Promise((resolve, reject) => {
          const proc = spawn(sshBin, [...baseArgs, opts.ssh, launch], { stdio: ["ignore", "ignore", "pipe"] });
          let err = ""; proc.stderr.on("data", (chunk) => { err = (err + chunk.toString()).slice(-6000); });
          proc.once("error", reject); proc.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Remote T3 start failed${err ? `: ${redact(err.trim())}` : ` (exit ${code})`}`)));
        });
      }
      await sleep(150);
    }
    if (!ready) throw new Error(`Timed out waiting for remote T3 server through SSH${stderr ? `: ${redact(stderr.trim())}` : ""}`);
    const pairing = `${shellQuote(opts.remoteCommand)} auth pairing create --base-dir ${stateDir} --base-url ${shellQuote(`http://127.0.0.1:${opts.remotePort}`)} --label t3-tode --json`;
    const result = await new Promise((resolve, reject) => {
      const proc = spawn(sshBin, [...baseArgs, opts.ssh, pairing], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", err = "";
      proc.stdout.on("data", (chunk) => { stdout += chunk; }); proc.stderr.on("data", (chunk) => { err = (err + chunk.toString()).slice(-6000); });
      proc.once("error", reject); proc.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Remote pairing command failed${err ? `: ${redact(err.trim())}` : ` (exit ${code})`}`)));
    });
    const parsed = JSON.parse(result);
    const pairUrl = parsed.pairUrl ?? parsed.pairingUrl ?? parsed.url;
    if (typeof pairUrl !== "string") throw new Error("T3 did not return a pairing URL");
    const remoteUrl = new URL(pairUrl);
    if (remoteUrl.pathname !== "/pair" || !remoteUrl.hash.startsWith("#token=")) throw new Error("T3 returned an invalid pairing URL");
    const url = `http://127.0.0.1:${port}/pair${remoteUrl.hash}`;
    let tunnelStopped = false;
    const stopAndDetach = async () => { if (tunnelStopped) return; tunnelStopped = true; signal?.removeEventListener("abort", abort); await stop(); };
    return { url, stop: stopAndDetach, description: `SSH ${opts.ssh} → 127.0.0.1:${opts.remotePort}` };
  } catch (error) { return fail(error); }
}
