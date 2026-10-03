import path from 'node:path';
import fs from 'node:fs';
export function parseOptions(args) {
  const out = {cwd: process.cwd(), port: 4773};
  const values = new Set(['--url', '--port', '--state-dir', '--profile', '--zoom', '--t3-command']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--help', '-h', '--version', '--doctor', '--serve', '--devtools', '--new-server'].includes(arg)) {
      out[arg.replace(/^--?/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    } else if (values.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      out[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[++i];
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (out.path) throw new Error('Only one project folder is supported');
    else {out.path = arg; out.cwd = path.resolve(arg);}
  }
  out.port = Number(out.port);
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('--port must be between 1 and 65535');
  if (out.zoom !== undefined) {
    out.zoom = Number(out.zoom);
    if (!Number.isFinite(out.zoom) || out.zoom < 0.25 || out.zoom > 3) throw new Error('--zoom must be between 0.25 and 3');
  }
  if (out.stateDir) out.stateDir = path.resolve(out.stateDir);
  if (!fs.statSync(out.cwd).isDirectory()) throw new Error(`Not a project folder: ${out.cwd}`);
  return out;
}
