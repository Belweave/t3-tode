import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {ensureBackend} from '../scripts/ensure-backend.mjs';
test('repairs a missing official backend from a verified archive and reuses it without downloading',async()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tode-backend-'));
  try {
    const t3Root=path.join(dir,'t3');fs.mkdirSync(t3Root);
    fs.writeFileSync(path.join(t3Root,'package.json'),JSON.stringify({name:'t3',version:'1.2.3'}));
    const source=path.join(dir,'package');fs.mkdirSync(source);
    fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({name:'@t3code/t3-linux-x64',version:'1.2.3'}));
    fs.writeFileSync(path.join(source,'t3'),'#!/bin/sh\necho fixture\n',{mode:0o755});
    const archive=path.join(dir,'archive.tgz');execFileSync('tar',['-czf',archive,'-C',dir,'package']);
    const bytes=fs.readFileSync(archive);
    const artifact={version:'1.2.3',url:'https://example.invalid/archive',integrity:`sha512-${createHash('sha512').update(bytes).digest('base64')}`};
    const binary=await ensureBackend({t3Root,artifact,platform:'linux-x64',fetchArchive:async()=>bytes});
    assert.match(execFileSync(binary,{encoding:'utf8'}),/fixture/);
    assert.equal(await ensureBackend({t3Root,artifact,platform:'linux-x64',fetchArchive:async()=>{throw new Error('must not download');}}),binary);
    fs.rmSync(path.dirname(binary),{recursive:true});
    await assert.rejects(ensureBackend({t3Root,artifact,platform:'linux-x64',fetchArchive:async()=>Buffer.from('corrupt')}),/integrity verification failed/);
    assert.equal(fs.existsSync(path.dirname(binary)),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
