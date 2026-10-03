import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseOptions} from '../src/options.mjs';
test('defaults and launch configuration', () => {
  assert.equal(parseOptions([]).port, 4773);
  assert.equal(parseOptions(['--new-server']).newServer,true);
  assert.equal(parseOptions(['--t3-command','/bin/t3']).t3Command,'/bin/t3');
  const out = parseOptions(['.', '--port','4000','--zoom','1.5','--serve']);
  assert.equal(out.cwd, process.cwd()); assert.equal(out.port,4000); assert.equal(out.zoom,1.5); assert.equal(out.serve,true);
});
test('invalid arguments fail before spawning anything', () => {
  for (const args of [['--port','0'],['--port','NaN'],['--zoom','4'],['--url'],['--bogus'],['.','.']]) assert.throws(() => parseOptions(args));
});
