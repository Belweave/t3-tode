import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {discoverEnvironment,resolveT3Command} from '../src/environment.mjs';
test('discovers a live existing environment and ignores stale runtime files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'t3-environment-'));
  const server = http.createServer((req,res) => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({environmentId:'existing',serverVersion:'1.2.3'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    fs.mkdirSync(path.join(dir,'userdata'));
    const file=path.join(dir,'userdata','server-runtime.json');
    fs.writeFileSync(file,JSON.stringify({version:1,pid:process.pid,port:server.address().port}));
    const result=await discoverEnvironment(dir);
    assert.equal(result.version,'1.2.3');assert.equal(result.descriptor.environmentId,'existing');
    fs.writeFileSync(path.join(dir,'userdata','environment-id'),'different-environment');
    assert.equal(await discoverEnvironment(dir),null);
    fs.unlinkSync(path.join(dir,'userdata','environment-id'));
    fs.writeFileSync(file,JSON.stringify({version:1,pid:2147483647,port:server.address().port}));
    assert.equal(await discoverEnvironment(dir),null);
  } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});
test('refuses a CLI with the wrong version before opening state',async()=> {
  await assert.rejects(resolveT3Command({version:'99.0.0',executable:process.execPath,fallback:[]}),/matching T3 Code CLI/);
});
