import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export function acquireProfile(profile) {
  fs.mkdirSync(profile,{recursive:true,mode:0o700});
  const file=path.join(profile,'.t3-tode-lock');
  const token=randomUUID();
  for (let attempt=0; attempt<3; attempt++) {
    try {
      const fd=fs.openSync(file,'wx',0o600);
      try {fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token}));} finally {fs.closeSync(fd);}
      const release=()=> {
        try {if (JSON.parse(fs.readFileSync(file,'utf8')).token === token) fs.unlinkSync(file);} catch {}
      };
      process.once('exit',release);
      return ()=> {process.off('exit',release);release();};
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try {owner=JSON.parse(fs.readFileSync(file,'utf8'));} catch {
        throw new Error('Browser profile is being opened by another client. Retry in a moment or use --profile with a different directory.');
      }
      let alive=true;
      try {process.kill(owner.pid,0);} catch (error) {if (error.code === 'ESRCH') alive=false;}
      if (alive) throw new Error(`Browser profile is already open (PID ${owner.pid}). Close that client with Ctrl+Q, or use --profile with a different directory.`);
      throw new Error(`A stopped client left a browser profile lock at ${file}. Verify no client is running, then remove that file, or use a different --profile directory.`);
    }
  }
  throw new Error('Could not acquire browser profile');
}
