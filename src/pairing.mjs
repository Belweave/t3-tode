import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run = promisify(execFile);
/** Mint a standard upstream client credential without printing its secret. */
export async function pairingUrl({command, stateDir, origin}) {
  const [program,...prefix] = command;
  const {stdout} = await run(program,[...prefix,'auth','pairing','create','--base-dir',stateDir,'--base-url',origin,'--label','t3-tode','--json'],{timeout:15000,maxBuffer:1024*1024});
  const result = JSON.parse(stdout);
  const link = result.pairUrl ?? result.pairingUrl ?? result.url;
  if (typeof link !== 'string' || !link.startsWith(new URL(origin).origin + '/pair#')) throw new Error('T3 did not return a valid pairing URL');
  return link;
}
