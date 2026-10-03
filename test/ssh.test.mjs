import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectSsh } from "../src/ssh.mjs";

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function fakeSsh(remotePort) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-ssh-fixture-"));
  const file = path.join(dir, "ssh-fixture.mjs");
  await fs.writeFile(file, `#!/usr/bin/env node
import net from 'node:net';
const a=process.argv.slice(2);
if(a.includes('-N')) { const spec=a[a.indexOf('-L')+1].split(':'); const s=net.createServer(c=>{const r=net.connect(${remotePort},'127.0.0.1'); c.pipe(r);r.pipe(c)}); s.listen(+spec[1],'127.0.0.1'); process.on('SIGTERM',()=>s.close(()=>process.exit(0))); }
else if(a.at(-1).includes('auth pairing create')) process.stdout.write(JSON.stringify({pairUrl:'http://127.0.0.1:${remotePort}/pair#token=secret-token'}));
else process.exit(2);
`);
  await fs.chmod(file, 0o755);
  return { file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("SSH tunnel forwards HTTP and rebases pairing token to loopback", async (t) => {
  const remote = await listen((req, res) => {
    if (req.url === "/.well-known/t3/environment") { res.writeHead(200); res.end('{"ok":true}'); }
    else { res.writeHead(200); res.end("app"); }
  });
  const fixture = await fakeSsh(remote.port);
  t.after(async () => { await remote.close(); await fixture.cleanup(); });
  const connection = await connectSsh({ ssh: "test-host", remotePort: remote.port, sshCommand: fixture.file, readyTimeoutMs: 3000 });
  try {
    assert.match(connection.url, /^http:\/\/127\.0\.0\.1:\d+\/pair#token=secret-token$/);
    const response = await fetch(connection.url.replace("/pair#token=secret-token", "/"));
    assert.equal(await response.text(), "app");
    assert.match(connection.description, /test-host/);
  } finally { await connection.stop(); }
});

test("SSH tunnel timeout cleans up and remote paths are safely quoted", async (t) => {
  const remote = await listen((_req, res) => { res.writeHead(404); res.end(); });
  const fixture = await fakeSsh(remote.port);
  t.after(async () => { await remote.close(); await fixture.cleanup(); });
  await assert.rejects(connectSsh({ ssh: "test-host", remotePort: remote.port, sshCommand: fixture.file, readyTimeoutMs: 300 }), /Timed out waiting/);
  await assert.rejects(connectSsh({ ssh: "-oProxyCommand=bad" }), /ssh must be/);
});

test("validation and already-aborted signals fail before spawning", async () => {
  await assert.rejects(connectSsh({ ssh: "host", sshPort: 70000 }), /sshPort/);
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await assert.rejects(connectSsh({ ssh: "host", signal: controller.signal }), /cancelled/);
});
