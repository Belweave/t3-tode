/**
 * A stand-in for the `t3` server used by backend tests. It reproduces the
 * observable lifecycle pieces src/backend.mjs depends on: parses `--port` /
 * `--base-dir`, binds loopback HTTP, serves the web app at `/`, writes
 * `<base-dir>/userdata/server-runtime.json` after the listener is up, and
 * shuts down on SIGTERM.
 *
 * Behavior is selected with the FAKE_T3_MODE environment variable:
 *   ok (default)  — normal server, exits on SIGTERM
 *   auto          — like ok, but picks its own free port (no --port passed)
 *   crash         — logs to stderr and exits with code 3 before binding
 *   silent        — never binds; hangs until killed (readiness timeout test)
 *   ignore-term   — binds but ignores SIGTERM (stop() escalation test)
 */

import fs from "node:fs";
import {spawn} from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const mode = process.env.FAKE_T3_MODE ?? "ok";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port" || arg === "--base-dir") {
      parsed[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

const { port: portArg, "base-dir": baseDir } = parseArgs(process.argv.slice(2));

if (mode === 'orphan') {
  const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {stdio:'ignore'});
  fs.mkdirSync(baseDir,{recursive:true});
  fs.writeFileSync(path.join(baseDir,'descendant.pid'),String(descendant.pid));
}

function writeRuntimeState(port) {
  const stateDir = path.join(baseDir, "userdata");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "server-runtime.json"),
    `${JSON.stringify({
      version: 1,
      pid: process.pid,
      host: "127.0.0.1",
      port,
      origin: `http://127.0.0.1:${port}`,
      startedAt: new Date().toISOString(),
    })}\n`,
  );
}

if (mode === "crash") {
  console.log("fake-t3: starting up");
  console.error("fatal: simulated crash before binding");
  process.exitCode = 3;
  setTimeout(() => process.exit(3), 50);
} else if (mode === "silent") {
  console.log("fake-t3: starting up but never binding");
  // Hang forever; the readiness timeout must kill us.
  setInterval(() => {}, 1_000);
} else {
  const start = async () => {
    let listenPort = Number(portArg);
    if (mode === "auto" || !Number.isInteger(listenPort) || listenPort < 1) {
      // Reserve a free loopback port the way the real server does.
      listenPort = await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const address = probe.address();
          probe.close(() => resolve(address.port));
        });
      });
    }

    const server = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("fake-t3-ready");
    });

    if (mode === "ignore-term") {
      process.on("SIGTERM", () => console.log("fake-t3: ignoring SIGTERM"));
      process.on("SIGINT", () => {});
    } else {
      process.on("SIGTERM", () => {
        console.log("fake-t3: shutting down gracefully");
        server.close(() => process.exit(0));
        // Safety exit in case close stalls.
        setTimeout(() => process.exit(0), 500).unref();
      });
    }

    server.listen(listenPort, "127.0.0.1", () => {
      console.log(`fake-t3: listening on 127.0.0.1:${listenPort}`);
      writeRuntimeState(listenPort);
    });
  };

  await start();
}
