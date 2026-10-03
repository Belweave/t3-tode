#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {parseOptions} from '../src/options.mjs';
import {acquireProfile} from '../src/profile.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = `t3-tode — T3 Code at pixel resolution in your terminal

Usage: t3-tode [project-folder] [options]

  --url <http(s) URL>  Connect to an existing T3 Code server or pairing link
  --port <number>     Local backend port (default: 4773)
  --state-dir <path>  T3 state directory (default: ~/.t3)
  --new-server       Use a separate, isolated backend
  --t3-command <exe>  Use this installed T3 CLI
  --profile <path>    Persistent browser profile directory
  --zoom <factor>     UI zoom, 0.25–3 (default: native resolution)
  --serve            Run the real T3 server without opening the terminal UI
  --devtools         Open Chromium developer tools
  --doctor           Check runtime, backend and terminal dependencies
  --version          Show version
  --help             Show this help

Requires a Kitty-graphics terminal such as Ghostty or Kitty.
The complete upstream web client runs against the upstream T3 backend.
`;
async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help || options.h) {console.log(help); return;}
  if (options.version) {console.log(`t3-tode ${JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version}`); return;}
  const pixelRoot = path.dirname(require.resolve('@zenbu-labs/pixel/package.json'));
  if (options.doctor) {
    const dist = path.join(pixelRoot,'electron','dist');
    const terminal = await import('@zenbu-labs/pixel/terminal');
    console.log(JSON.stringify({node:process.version, platform:process.platform, architecture:process.arch,
      pixel:JSON.parse(fs.readFileSync(path.join(pixelRoot,'package.json'))).version,
      pixelRuntimeInstalled:fs.existsSync(path.join(dist,'.zenbu-electron-sha256')),
      t3:JSON.parse(fs.readFileSync(require.resolve('t3/package.json'))).version,
      terminal:terminal.detect()?.name ?? 'unknown', tty:Boolean(process.stdin.isTTY),
      project:options.cwd},null,2));
    return;
  }
  if (!options.serve && !process.stdin.isTTY && !process.env.PIXEL_TTY && !process.env.PIXEL_EMBED) throw new Error('A terminal is required. Use --serve to start just the backend.');
  const {startBackend,validateUrl} = await import('../src/backend.mjs');
  const fallbackCommand = [process.execPath, path.join(path.dirname(require.resolve('t3/package.json')), 'dist', 'bin.mjs')];
  const {discoverEnvironment,resolveT3Command,defaultStateDir} = await import('../src/environment.mjs');
  options.stateDir ??= options.newServer ? path.join(os.homedir(), '.local', 'share', 't3-tode', 'backend') : defaultStateDir();
  const abort = new AbortController();
  options.signal = abort.signal;
  const profile = options.profile ? path.resolve(options.profile) : path.join(os.homedir(),'.local','share','t3-tode','browser');
  const releaseProfile = options.serve ? () => {} : acquireProfile(profile);
  let backend;
  let child;
  let childExit;
  let interrupted = false;
  let wakeServe;
  const onSignal = () => {
    interrupted = true;
    abort.abort();
    child?.kill('SIGTERM');
    wakeServe?.();
  };
  for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal, onSignal);
  try {
    let startupPairing;
    options.onLog = line => {
      const match = line.match(/http:\/\/127\.0\.0\.1:\d+\/pair#token=[A-Za-z0-9_-]+/);
      if (match) startupPairing = match[0];
    };
    let url;
    if (options.url) url = String(validateUrl(options.url));
    else {
      const existing = options.newServer ? null : await discoverEnvironment(options.stateDir);
      const command = options.newServer && !options.t3Command ? fallbackCommand : await resolveT3Command({version:existing?.version,fallback:fallbackCommand,executable:options.t3Command});
      if (existing) {
        console.error(`Connecting to existing T3 Code at ${existing.url}…`);
        url = await (await import('../src/pairing.mjs')).pairingUrl({command,stateDir:options.stateDir,origin:existing.url});
      } else {
        // Existing databases require an explicitly selected installed CLI, avoiding
        // silent migrations by the bundled release when the desktop is closed.
        const versionMarker = path.join(options.stateDir,'t3-tode-bundled-version');
        let bundledVersion;
        try {bundledVersion = fs.readFileSync(versionMarker,'utf8').trim();} catch {}
        const bundledRelease = JSON.parse(fs.readFileSync(require.resolve('t3/package.json'))).version;
        if (!options.newServer && bundledVersion !== bundledRelease && fs.existsSync(path.join(options.stateDir,'userdata','statev2.sqlite')) && command === fallbackCommand) throw new Error('Existing T3 state requires an installed T3 CLI. Install its version or pass --t3-command.');
        console.error(`Starting T3 Code using ${options.stateDir}…`);
        options.command = command;
        if (options.path) options.command = [...command,'--auto-bootstrap-project-from-cwd'];
        backend = await startBackend(options);
        if (command === fallbackCommand) fs.writeFileSync(versionMarker,bundledRelease,{mode:0o600});
        if (interrupted) return;
        for (let attempt=0; !startupPairing && attempt<20 && !interrupted; attempt++) await new Promise(resolve => setTimeout(resolve,100));
        if (interrupted) return;
        url = startupPairing ?? await (await import('../src/pairing.mjs')).pairingUrl({command,stateDir:options.stateDir,origin:backend.url});
      }
    }
    if (interrupted) return;
    if (options.serve) {
      console.log(`T3 Code ready: ${url}`);
      await new Promise(resolve => {wakeServe = resolve; if (interrupted) resolve();});
      return;
    }
    const env = {...process.env, T3_TODE_URL:String(url),
      T3_TODE_PROFILE:profile,
      T3_TODE_DEVTOOLS:options.devtools ? '1':'0', T3_TODE_ZOOM:options.zoom ? String(options.zoom):''};
    fs.mkdirSync(env.T3_TODE_PROFILE,{recursive:true,mode:0o700});
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(process.execPath,[path.join(pixelRoot,'dist','bin.js'),path.join(root,'src','window.cjs'),'--',`--user-data-dir=${env.T3_TODE_PROFILE}`],{stdio:'inherit',env,cwd:options.cwd});
    childExit = new Promise((resolve,reject) => {child.once('error',reject); child.once('exit',code => resolve(code ?? 1));});
    process.exitCode = await childExit;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'),4000);
      try {await childExit;} finally {clearTimeout(timer);}
    }
    try {await backend?.stop();} finally {releaseProfile();}
    for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.off(signal,onSignal);
  }
}
main().catch(error => {console.error(`t3-tode: ${error.message}`); process.exitCode = 1;});
