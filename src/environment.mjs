import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run = promisify(execFile);

export async function discoverEnvironment(stateDir) {
  for (const directory of ['userdata', 'dev']) {
    let runtime;
    try {runtime = JSON.parse(fs.readFileSync(path.join(stateDir,directory,'server-runtime.json'),'utf8'));} catch {continue;}
    if (runtime.version !== 1 || !Number.isInteger(runtime.pid) || !Number.isInteger(runtime.port)) continue;
    try {process.kill(runtime.pid,0);} catch {continue;}
    const origin = `http://127.0.0.1:${runtime.port}`;
    try {
      const response = await fetch(`${origin}/.well-known/t3/environment`,{signal:AbortSignal.timeout(2500)});
      if (!response.ok) continue;
      const descriptor = await response.json();
      if (typeof descriptor.environmentId !== 'string' || typeof descriptor.serverVersion !== 'string') continue;
      let storedId;
      try {storedId = fs.readFileSync(path.join(stateDir,directory,'environment-id'),'utf8').trim();} catch {}
      if (storedId && storedId !== descriptor.environmentId) continue;
      return {url:origin,version:descriptor.serverVersion,stateDir,descriptor};
    } catch {}
  }
  return null;
}

export async function resolveT3Command({version, fallback, executable}) {
  const candidates = executable ? [[executable]] : [];
  if (!executable && process.platform === 'darwin') {
    for (const name of ['T3 Code (Nightly)','T3 Code']) {
      const app = `/Applications/${name}.app/Contents`;
      if (fs.existsSync(`${app}/Resources/app.asar`)) candidates.push(['/usr/bin/env','ELECTRON_RUN_AS_NODE=1',`${app}/MacOS/${name}`,`${app}/Resources/app.asar/apps/server/dist/bin.mjs`]);
    }
  }
  if (!executable) candidates.push(['t3'], fallback);
  for (const command of candidates) {
    try {
      const {stdout} = await run(command[0],[...command.slice(1),'--version'],{timeout:15000});
      const found = stdout.trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+[^\s]*)/)?.[1];
      if (found && (!version || found === version)) return command;
    } catch {}
  }
  throw new Error(`Cannot find a matching T3 Code CLI${version ? ` (${version})` : ''}. Install that version or pass --t3-command /path/to/t3. Existing state was not opened with a different version.`);
}
export const defaultStateDir = () => path.join(os.homedir(),'.t3');
