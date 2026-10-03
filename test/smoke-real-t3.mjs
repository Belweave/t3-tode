/**
 * Real smoke test: launch the official npm t3 backend + web frontend through
 * src/backend.mjs exactly the way t3-tode will (npx fallback command, scratch
 * state dir, explicit loopback port), verify the web app answers, then stop.
 *
 * Usage: node test/smoke-real-t3.mjs [port]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBackend, redactLog } from "../src/backend.mjs";

const port = Number(process.argv[2] ?? 37991);
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-tode-smoke-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-tode-smoke-proj-"));

console.log(`[smoke] launching official t3@0.0.45 on 127.0.0.1:${port}`);
console.log(`[smoke] stateDir: ${stateDir}`);
console.log(`[smoke] log tail will print on failure; first-run npx download can take a while`);

const started = Date.now();
const backend = await startBackend({
  cwd: projectDir,
  port,
  stateDir,
  command: ["npx", "t3@0.0.45"],
  readyTimeoutMs: 10 * 60_000, // first npx run downloads the platform binary
  onLog: (line, source) => console.log(`[t3 ${source}] ${redactLog(line)}`),
});
console.log(`[smoke] ready in ${((Date.now() - started) / 1000).toFixed(1)}s at ${backend.url}`);

try {
  const response = await fetch(backend.url, { headers: { accept: "text/html" } });
  const html = await response.text();
  console.log(`[smoke] GET ${backend.url} -> ${response.status} (${html.length} bytes)`);
  assert.equal(response.status, 200);
  assert.ok(html.length > 1000, "web app html should be substantial");
  console.log(`[smoke] title: ${(html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? "(none)"}`);
  const runtimeState = JSON.parse(
    fs.readFileSync(path.join(stateDir, "userdata", "server-runtime.json"), "utf8"),
  );
  console.log(
    `[smoke] runtime state: origin=${runtimeState.origin} pid=${runtimeState.pid} port=${runtimeState.port}`,
  );
  assert.equal(runtimeState.port, port);
  assert.equal(runtimeState.origin, `http://127.0.0.1:${port}`);
  console.log("[smoke] OK");
} finally {
  const stopStart = Date.now();
  await backend.stop();
  console.log(`[smoke] stopped in ${((Date.now() - stopStart) / 1000).toFixed(1)}s`);
}
