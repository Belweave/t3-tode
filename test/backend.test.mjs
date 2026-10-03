/**
 * Tests for src/backend.mjs.
 *
 * The launch tests run against test/fixtures/fake-t3.mjs, which mimics the
 * parts of the real `t3` server this module depends on (loopback HTTP, the
 * runtime state file, SIGTERM shutdown) without needing the npm `t3`
 * dependency installed. Run with: node --test test/backend.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BackendError,
  RECOMMENDED_T3_VERSION,
  findT3OnPath,
  isLoopbackHostname,
  normalizeCommand,
  serverArgs,
  startBackend,
  validateUrl,
} from "../src/backend.mjs";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "fake-t3.mjs");
const IS_WINDOWS = process.platform === "win32";

/** Grab a free loopback port by binding port 0 and releasing it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

async function tempDir(prefix) {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function until(predicate, timeoutMs = 5_000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** True when nothing is listening on 127.0.0.1:port. */
function expectClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error(`something is still listening on port ${port}`));
    });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`something is still listening on port ${port}`));
    });
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(error);
    });
  });
}

/** A backend launch config pointed at the fake server in a scratch state dir. */
async function fakeLaunch(mode, extra = {}) {
  const stateDir = await tempDir("t3-tode-test-");
  const projectDir = path.join(stateDir, "project");
  await fs.promises.mkdir(projectDir, { recursive: true });
  return {
    stateDir,
    projectDir,
    options: {
      cwd: projectDir,
      stateDir,
      command: ["node", FIXTURE],
      readyTimeoutMs: extra.readyTimeoutMs ?? 15_000,
      stopGraceMs: extra.stopGraceMs,
      port: extra.port,
      onLog: extra.onLog,
    },
    env: { ...process.env, FAKE_T3_MODE: mode, ...(extra.env ?? {}) },
  };
}

// validateUrl -----------------------------------------------------------------

test("validateUrl accepts loopback http(s) urls and preserves path, query and hash", () => {
  for (const input of [
    "http://127.0.0.1:3773",
    "http://127.0.0.1:3773/",
    "https://[::1]:8443/app",
    "http://localhost:3000",
    "http://127.0.0.1:3773/pair#token=abc123",
    "http://127.0.0.1:3773/?env=x&thread=1",
  ]) {
    const url = validateUrl(input);
    assert.ok(url instanceof URL, `expected URL for ${input}`);
    assert.ok(isLoopbackHostname(url.hostname), `expected loopback hostname for ${input}`);
  }
  const paired = validateUrl("http://127.0.0.1:3773/pair#token=abc123");
  assert.equal(paired.pathname, "/pair");
  assert.equal(paired.hash, "#token=abc123");
  assert.equal(validateUrl("http://LocalHost:80/x").hostname, "localhost");
});

test("validateUrl rejects non-urls and non-http schemes", () => {
  for (const input of [
    "",
    "   ",
    "not a url",
    "127.0.0.1:3773",
    "ftp://127.0.0.1",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => validateUrl(input), TypeError, `expected rejection for "${input}"`);
  }
  assert.throws(() => validateUrl(undefined), TypeError);
  assert.throws(() => validateUrl(null), TypeError);
});

test("isLoopbackHostname matches the t3 server's loopback set", () => {
  for (const host of ["127.0.0.1", "127.9.9.9", "localhost", "LOCALHOST", "::1", "[::1]"]) {
    assert.equal(isLoopbackHostname(host), true, host);
  }
  for (const host of ["0.0.0.0", "192.168.0.1", "t3.codes", "example.test", "", undefined]) {
    assert.equal(isLoopbackHostname(host), false, String(host));
  }
});

// serverArgs ------------------------------------------------------------------

test("serverArgs always enforces web mode, no browser and loopback host", () => {
  const args = serverArgs({});
  const required = (flag) => args.indexOf(flag);
  assert.ok(required("--mode") !== -1 && args[required("--mode") + 1] === "web");
  assert.ok(required("--no-browser") !== -1);
  assert.ok(required("--host") !== -1 && args[required("--host") + 1] === "127.0.0.1");
});

test("serverArgs includes port, base-dir and cwd positional last", () => {
  const args = serverArgs({ cwd: "~/proj", port: 4321, stateDir: "/tmp/state" });
  assert.deepEqual(args.slice(args.length - 1), [path.resolve(os.homedir(), "proj")]);
  assert.ok(args.includes("--port") && args.includes("4321"));
  assert.ok(args.includes("--base-dir") && args.includes(path.resolve("/tmp/state")));
  assert.ok(args.lastIndexOf(path.resolve(os.homedir(), "proj")) > args.lastIndexOf("--host"));
});

test("serverArgs omits unspecified pieces", () => {
  assert.deepEqual(serverArgs({}), ["--mode", "web", "--no-browser", "--host", "127.0.0.1"]);
});

test("serverArgs rejects invalid options", () => {
  assert.throws(() => serverArgs({ port: 0 }), TypeError);
  assert.throws(() => serverArgs({ port: 70000 }), TypeError);
  assert.throws(() => serverArgs({ port: 1.5 }), TypeError);
  assert.throws(() => serverArgs({ port: "4321" }), TypeError);
  assert.throws(() => serverArgs({ stateDir: "" }), TypeError);
  assert.throws(() => serverArgs({ cwd: "" }), TypeError);
  assert.throws(() => serverArgs({ stateDir: 42 }), TypeError);
});

// command resolution ----------------------------------------------------------

test("findT3OnPath finds an executable on the provided PATH", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-path-"));
  const fakeT3 = path.join(binDir, IS_WINDOWS ? "t3.cmd" : "t3");
  fs.writeFileSync(fakeT3, "#!/bin/sh\n");
  fs.chmodSync(fakeT3, 0o755);
  const found = findT3OnPath({ PATH: `${binDir}${path.delimiter}/elsewhere` });
  assert.equal(found, fakeT3);
  assert.equal(findT3OnPath({ PATH: "/nonexistent-dir-only" }), null);
  assert.equal(findT3OnPath({}), null);
});

test("normalizeCommand default prefers PATH t3, else falls back to npx with the pinned version", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-path-"));
  const fakeT3 = path.join(binDir, IS_WINDOWS ? "t3.cmd" : "t3");
  fs.writeFileSync(fakeT3, "");
  const onPath = normalizeCommand(undefined, { PATH: binDir });
  assert.equal(onPath.program, fakeT3);
  assert.deepEqual(onPath.baseArgs, []);

  const fallback = normalizeCommand(undefined, { PATH: "/nope" });
  assert.ok(fallback.program.includes("npx"));
  assert.deepEqual(fallback.baseArgs, [`t3@${RECOMMENDED_T3_VERSION}`]);
});

test("normalizeCommand accepts strings and arrays and rejects junk", () => {
  assert.deepEqual(normalizeCommand("/usr/local/bin/t3"), { program: "/usr/local/bin/t3", baseArgs: [] });
  const array = normalizeCommand(["npx", "t3@0.0.45", "--foo"]);
  assert.deepEqual(array, { program: "npx", baseArgs: ["t3@0.0.45", "--foo"] });
  assert.throws(() => normalizeCommand(""), TypeError);
  assert.throws(() => normalizeCommand([]), TypeError);
  assert.throws(() => normalizeCommand([1, 2]), TypeError);
  assert.throws(() => normalizeCommand(["t3", 5]), TypeError);
  assert.throws(() => normalizeCommand(42), TypeError);
});

// startBackend ----------------------------------------------------------------

test("startBackend launches the server, reports a loopback url and stop() releases it", async () => {
  const setup = await fakeLaunch("ok", { port: await freePort() });
  const captured = [];
  const options = { ...setup.options, env: setup.env };
  options.onLog = (line, source) => captured.push({ line, source });

  const backend = await startBackend(options);
  try {
    assert.match(backend.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(new URL(backend.url).port, String(setup.options.port));
    assert.equal(processAlive(backend.pid), true);

    const response = await fetch(backend.url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "fake-t3-ready");

    assert.ok(fs.existsSync(backend.logFile), "log file should exist");
    const logContents = fs.readFileSync(backend.logFile, "utf8");
    assert.match(logContents, /fake-t3: listening/);
    assert.ok(captured.some((entry) => entry.line.includes("listening")));
  } finally {
    await backend.stop();
  }
  assert.equal(processAlive(backend.pid), false);
  await expectClosed(setup.options.port);
  await backend.stop(); // idempotent
});

test("startBackend surfaces a crashing server with exit code and log tail", async () => {
  const setup = await fakeLaunch("crash", { port: await freePort() });
  await assert.rejects(
    () => startBackend({ ...setup.options, env: setup.env }),
    (error) => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, "START_EXITED");
      assert.equal(error.exitCode, 3);
      assert.match(error.logTail, /simulated crash/);
      assert.match(error.message, /code 3/);
      return true;
    },
  );
});

test("startBackend reports spawn failures clearly", async () => {
  const stateDir = await tempDir("t3-tode-test-");
  await assert.rejects(
    () =>
      startBackend({
        stateDir,
        command: ["definitely-not-a-real-binary-xyz"],
        readyTimeoutMs: 5_000,
      }),
    (error) => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, "SPAWN_ERROR");
      assert.match(error.message, /failed to spawn/);
      return true;
    },
  );
});

test("startBackend times out when the server never binds and kills the child", async () => {
  const setup = await fakeLaunch("silent", { readyTimeoutMs: 900 });
  const error = await startBackend({ ...setup.options, env: setup.env }).catch((caught) => caught);
  assert.ok(error instanceof BackendError);
  assert.equal(error.code, "TIMEOUT");
  assert.match(error.message, /did not become ready/);
  assert.match(error.message, /runtime state file/);
  assert.equal(typeof error.pid, "number");
  await until(() => !processAlive(error.pid), 5_000);
});

test("startBackend rejects with PORT_IN_USE when the port is taken before launch", async () => {
  const port = await freePort();
  const occupant = net.createServer();
  await new Promise((resolve) => occupant.listen(port, "127.0.0.1", resolve));
  try {
    const setup = await fakeLaunch("ok", { port });
    await assert.rejects(
      () => startBackend({ ...setup.options, env: setup.env }),
      (error) => {
        assert.ok(error instanceof BackendError);
        assert.equal(error.code, "PORT_IN_USE");
        assert.match(error.message, /already in use/);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => occupant.close(resolve));
  }
});

test("startBackend discovers the port from the runtime state file when none is given", async () => {
  const setup = await fakeLaunch("auto");
  const backend = await startBackend({ ...setup.options, env: setup.env });
  try {
    const port = Number(new URL(backend.url).port);
    assert.ok(port >= 1 && port <= 65535);
    const state = JSON.parse(
      fs.readFileSync(path.join(setup.stateDir, "userdata", "server-runtime.json"), "utf8"),
    );
    assert.equal(port, state.port);
    const response = await fetch(backend.url);
    assert.equal(response.status, 200);
  } finally {
    await backend.stop();
  }
  assert.equal(processAlive(backend.pid), false);
});

test("stop() escalates to SIGKILL when the server ignores SIGTERM", async () => {
  const setup = await fakeLaunch("ignore-term", { port: await freePort(), stopGraceMs: 400 });
  const backend = await startBackend({ ...setup.options, env: setup.env });
  const startedAt = Date.now();
  await backend.stop();
  assert.ok(Date.now() - startedAt < 5_000, "stop should not wait the full default grace");
  assert.equal(processAlive(backend.pid), false);
});

test("startBackend validates its options before spawning anything", async () => {
  await assert.rejects(() => startBackend({ port: 0 }), TypeError);
  await assert.rejects(() => startBackend({ readyTimeoutMs: -1 }), TypeError);
  await assert.rejects(() => startBackend({ stopGraceMs: 0 }), TypeError);
  await assert.rejects(() => startBackend({ onLog: "nope" }), TypeError);
  await assert.rejects(() => startBackend({ command: 7 }), TypeError);
});

test("explicit remote HTTP(S) attach and pairing fragments are preserved", () => {
  assert.equal(validateUrl('https://t3.example/pair#token=test').href,'https://t3.example/pair#token=test');
  assert.equal(validateUrl('http://192.168.1.5:4773').hostname,'192.168.1.5');
});

test("backend logs redact credentials", async () => {
  const {redactLog} = await import('../src/backend.mjs');
  assert.equal(redactLog('pairingUrl: http://127.0.0.1:4773/pair#token=SECRET'), 'pairingUrl: http://127.0.0.1:4773/pair#token=[redacted]');
});

test("backend logs rotate at 5 MiB, retain one prior file, and redact rotated content", async () => {
  const stateDir = await tempDir("t3-tode-log-rotation-");
  const projectDir = path.join(stateDir, "project");
  await fs.promises.mkdir(projectDir);
  const script = path.join(stateDir, "large-logger.mjs");
  await fs.promises.writeFile(script, `
    import fs from "node:fs";
    import http from "node:http";
    import path from "node:path";
    const args = process.argv.slice(1);
    const value = (flag) => args[args.indexOf(flag) + 1];
    const base = value("--base-dir");
    const port = Number(value("--port"));
    for (let i = 0; i < 7; i++) console.log("bulk-" + i + ":" + "x".repeat(1024 * 1024));
    console.log("pairing URL http://127.0.0.1:" + port + "/pair#token=ROTATION_SECRET");
    const server = http.createServer((_req, res) => res.end("ready"));
    server.listen(port, "127.0.0.1", () => {
      const dir = path.join(base, "userdata");
      fs.mkdirSync(dir, {recursive:true});
      fs.writeFileSync(path.join(dir, "server-runtime.json"), JSON.stringify({version:1,pid:process.pid,port,startedAt:new Date().toISOString()}));
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `);
  const logFile = path.join(stateDir, "userdata", "logs", "t3-tode-backend.log");
  await fs.promises.mkdir(path.dirname(logFile), {recursive:true});
  await fs.promises.writeFile(logFile, Buffer.alloc(6 * 1024 * 1024, "o"));
  const backend = await startBackend({stateDir, cwd:projectDir, port:await freePort(), command:[process.execPath,script]});
  try {
    await until(() => fs.existsSync(`${logFile}.1`) && fs.statSync(logFile).size > 0, 10_000);
    const currentSize = fs.statSync(logFile).size;
    const priorSize = fs.statSync(`${logFile}.1`).size;
    assert.ok(currentSize <= 5 * 1024 * 1024);
    assert.ok(priorSize <= 5 * 1024 * 1024);
    assert.ok(currentSize + priorSize <= 10 * 1024 * 1024);
    assert.equal(fs.existsSync(`${logFile}.2`), false);
    assert.doesNotMatch(fs.readFileSync(logFile, "utf8") + fs.readFileSync(`${logFile}.1`, "utf8"), /ROTATION_SECRET/);
  } finally {
    await backend.stop();
  }
});

test("interrupted startup cleans up its process", async () => {
  const setup = await fakeLaunch('silent', {port:await freePort()});
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(),100);
  try {await assert.rejects(startBackend({...setup.options,env:setup.env,signal:abort.signal}), error => {
    assert.equal(error.code,'ABORTED');
    assert.equal(processAlive(error.pid),false);
    return true;
  });}
  finally {clearTimeout(timer);}
});

test("stop kills a descendant that outlives its direct parent", async () => {
  const setup = await fakeLaunch('orphan',{port:await freePort(),stopGraceMs:500});
  const backend = await startBackend({...setup.options,env:setup.env});
  try {
    const descendant = Number(fs.readFileSync(path.join(setup.stateDir,'descendant.pid'),'utf8'));
    assert.equal(processAlive(descendant),true);
    await backend.stop();
    await until(() => !processAlive(descendant));
    assert.equal(processAlive(backend.pid),false);
  } finally {await backend.stop();}
});
