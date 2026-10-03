import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

// Exercise the real installer with checksum-verified fixture archives and no network.
test('installer handles spaces, atomically updates, and preserves installation on a bad checksum',()=> {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'tode install '));
  try {
    const downloads=path.join(home,'downloads');fs.mkdirSync(downloads);
    const app=path.join(home,'t3-tode');fs.mkdirSync(path.join(app,'bin'),{recursive:true});
    fs.writeFileSync(path.join(app,'bin','t3-tode.mjs'),'console.log("fixture doctor OK");');
    fs.mkdirSync(path.join(app,'node_modules','@zenbu-labs','pixel','scripts'),{recursive:true});
    fs.writeFileSync(path.join(app,'node_modules','@zenbu-labs','pixel','scripts','postinstall.mjs'),'// fixture runtime installation');
    fs.mkdirSync(path.join(app,'scripts'));
    fs.writeFileSync(path.join(app,'scripts','ensure-backend.mjs'),'// fixture backend installation');
    const asset='t3-tode-v0.1.0.tar.gz';
    execFileSync('tar',['-czf',path.join(downloads,asset),'-C',home,'t3-tode']);
    const nodeDir=path.join(home,'node-v24.21.0-darwin-arm64');fs.mkdirSync(path.join(nodeDir,'bin'),{recursive:true});
    fs.symlinkSync(process.execPath,path.join(nodeDir,'bin','node'));
    fs.writeFileSync(path.join(nodeDir,'bin','npm'),'#!/bin/sh\nexit 0\n',{mode:0o755});
    const nodeAsset='node-v24.21.0-darwin-arm64.tar.gz';
    execFileSync('tar',['-czf',path.join(downloads,nodeAsset),'-C',home,path.basename(nodeDir)]);
    const hash=file=>createHash('sha256').update(fs.readFileSync(path.join(downloads,file))).digest('hex');
    fs.writeFileSync(path.join(downloads,'SHA256SUMS'),`${hash(asset)}  ${asset}\n`);
    fs.writeFileSync(path.join(downloads,'SHASUMS256.txt'),`${hash(nodeAsset)}  ${nodeAsset}\n`);
    const mocks=path.join(home,'mocks');fs.mkdirSync(mocks);
    fs.writeFileSync(path.join(mocks,'uname'),'#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; esac\n',{mode:0o755});
    fs.writeFileSync(path.join(mocks,'curl'),'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in https://*) url="$1";; -o) shift; dest="$1";; esac; shift; done\ncp "$FIXTURE_DOWNLOADS/${url##*/}" "$dest"\n',{mode:0o755});
    for (const manager of ['npm','pnpm','bun']) fs.writeFileSync(path.join(mocks,manager),'#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$FIXTURE_MANAGER_LOG"\nexit 0\n',{mode:0o755});
    const install=path.join(home,'app with spaces');const bin=path.join(home,'bin with spaces');
    const env={...process.env,HOME:home,PATH:`${mocks}:${process.env.PATH}`,FIXTURE_DOWNLOADS:downloads,T3_TODE_INSTALL_DIR:install,T3_TODE_BIN_DIR:bin,T3_TODE_VERSION:'v0.1.0',T3_TODE_PACKAGE_MANAGER:'npm',T3_TODE_NODE_DOWNLOAD:'1',FIXTURE_MANAGER_LOG:path.join(home,'manager.log')};
    const run=()=>spawnSync('bash',['install.sh'],{env,encoding:'utf8'});
    let result=run();assert.equal(result.status,0,result.stderr);
    const first=fs.readlinkSync(path.join(install,'current'));
    assert.match(execFileSync(path.join(bin,'t3-tode'),['--doctor'],{encoding:'utf8'}),/fixture doctor OK/);
    result=run();assert.equal(result.status,0,result.stderr);
    assert.notEqual(fs.readlinkSync(path.join(install,'current')),first);
    for (const profile of ['.profile','.bashrc','.zshrc']) assert.equal(fs.readFileSync(path.join(home,profile),'utf8').split('t3-tode PATH').length-1,1);
    for (const manager of ['pnpm','bun']) {
      env.T3_TODE_PACKAGE_MANAGER=manager;env.T3_TODE_NODE_DOWNLOAD='0';
      result=run();assert.equal(result.status,0,result.stderr);
      assert.match(result.stdout,/Reusing Node/);
      assert.match(fs.readFileSync(env.FIXTURE_MANAGER_LOG,'utf8'),new RegExp(manager+' .*install'));
    }
    const before=fs.readlinkSync(path.join(install,'current'));
    fs.appendFileSync(path.join(downloads,asset),'tampered');
    result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/checksum verification failed/);
    assert.equal(fs.readlinkSync(path.join(install,'current')),before);
    assert.ok(!fs.readdirSync(path.join(install,'releases')).some(file=>file.startsWith('.install-')));
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});
