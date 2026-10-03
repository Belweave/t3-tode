const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app} = require('@zenbu-labs/pixel/electron');
const {createRoot} = require('@zenbu-labs/pixel');

const url = process.env.T3_TODE_URL;
if (!url) throw new Error('Launch this window through t3-tode');
const profile = process.env.T3_TODE_PROFILE || path.join(os.homedir(), '.local', 'share', 't3-tode', 'browser');
fs.mkdirSync(profile, {recursive:true, mode:0o700});
app.setPath('userData', profile);
app.setPath('sessionData', profile);
if (!app.requestSingleInstanceLock()) {
  console.error('t3-tode: This browser profile is already in use. Close the other client or choose another --profile.');
  app.exit(1);
  return;
}
let browserSession;
const root = createRoot({name:'t3-tode', devtools:false,
  onKey(event) {
    if (event.kind === 'press' && event.mods.ctrl && !event.mods.alt && event.key.toLowerCase() === 'q') {root.stop(); return true;}
  },
  async onExit(code) {
    let timer;
    try {
      browserSession?.flushStorageData();
      await Promise.race([browserSession?.cookies.flushStore(), new Promise(resolve => {timer = setTimeout(resolve,1500);})]);
    } finally {clearTimeout(timer); app.exit(code);}
  }
});
const view = root.loadURL(url, {
  partition:'persist:t3-tode',
  clipboardRead:true,
  onOpenWindow:'popup',
  devtools:process.env.T3_TODE_DEVTOOLS === '1',
});
browserSession = view.webContents.session;
view.webContents.on('did-finish-load', () => {
  if (process.env.T3_TODE_ZOOM) view.webContents.setZoomFactor(Number(process.env.T3_TODE_ZOOM));
});
view.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
  if (isMainFrame && code !== -3) console.error(`t3-tode: ${description} (${String(failedUrl).split(/[?#]/)[0]})`);
});
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal, () => root.stop());
