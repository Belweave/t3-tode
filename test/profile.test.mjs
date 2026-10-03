import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {acquireProfile} from '../src/profile.mjs';
test('a profile is exclusive and can be reopened after release',()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tode-profile-'));
  const release=acquireProfile(dir);
  try {assert.throws(()=>acquireProfile(dir),/already open/);} finally {release();}
  acquireProfile(dir)();
});
test('a stale lock requires explicit recovery and is never unlinked by a racing launcher',()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tode-profile-'));
  fs.writeFileSync(path.join(dir,'.t3-tode-lock'),JSON.stringify({pid:2147483647,token:'stale'}));
  assert.throws(()=>acquireProfile(dir),/stopped client/);
  assert.equal(fs.existsSync(path.join(dir,'.t3-tode-lock')),true);
});
