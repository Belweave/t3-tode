/** Repair skipped optional upstream binaries using the exact, verified npm archive.
 * npm may reject T3's entire Linux bundle because it includes both libc variants.
 * This preserves the official executable and its bundled dependencies unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);

export async function ensureBackend({t3Root, artifact, platform=`${process.platform}-${process.arch}`, fetchArchive=async url=> {
  const response=await fetch(url,{signal:AbortSignal.timeout(180000)});
  if (!response.ok) throw new Error(`Backend archive download returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}}={}) {
  t3Root ??= path.dirname(require.resolve('t3/package.json'));
  const manifest=JSON.parse(fs.readFileSync(path.join(t3Root,'package.json'),'utf8'));
  const name=`@t3code/t3-${platform}`;
  const executable=platform.startsWith('win32-') ? 't3.exe' : 't3';
  const localRequire=createRequire(path.join(t3Root,'package.json'));
  try {
    const existing=path.join(path.dirname(localRequire.resolve(`${name}/package.json`)),executable);
    if (fs.statSync(existing).isFile()) return existing;
  } catch {}
  artifact ??= JSON.parse(fs.readFileSync(new URL('../src/backend-artifacts.json',import.meta.url),'utf8'))[platform];
  if (!artifact) {
    console.warn(`t3-tode: No bundled T3 binary for ${platform}; use an installed compatible T3 CLI.`);
    return null;
  }
  if (artifact.version !== manifest.version || !/^sha512-[A-Za-z0-9+/]+=*$/.test(artifact.integrity)) throw new Error('Backend artifact version/integrity does not match the pinned T3 package');
  console.error(`t3-tode: Installing missing official T3 ${manifest.version} binary (${platform})…`);
  const bytes=await fetchArchive(artifact.url);
  const actual=`sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actual !== artifact.integrity) throw new Error('Official T3 archive integrity verification failed');
  const parent=path.join(t3Root,'node_modules','@t3code');
  fs.mkdirSync(parent,{recursive:true});
  const temporary=fs.mkdtempSync(path.join(parent,'.t3-tode-'));
  const target=path.join(parent,`t3-${platform}`);
  try {
    const archive=path.join(temporary,'archive.tgz');fs.writeFileSync(archive,bytes);
    const unpacked=path.join(temporary,'unpacked');fs.mkdirSync(unpacked);
    execFileSync('tar',['-xzf',archive,'-C',unpacked,'--strip-components=1']);
    const extracted=JSON.parse(fs.readFileSync(path.join(unpacked,'package.json'),'utf8'));
    if (extracted.name !== name || extracted.version !== manifest.version || !fs.statSync(path.join(unpacked,executable)).isFile()) throw new Error('Official backend archive contents do not match the expected package');
    fs.rmSync(target,{recursive:true,force:true});
    fs.renameSync(unpacked,target);
    return fs.realpathSync(path.join(target,executable));
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureBackend().catch(error=>{console.error(`t3-tode: ${error.message}`);process.exitCode=1;});
}
