#!/usr/bin/env python3
"""Exercise the actual Pixel renderer through a PTY and decode its Kitty frame.
Requires a running scratch T3 server; this is a developer check.
Usage: python3 scripts/native-smoke.py [port] [backend-state-directory]
"""
import os, pty, fcntl, termios, struct, subprocess, select, time, re, base64, zlib, json, signal
from pathlib import Path
import binascii
def save_png(dest, w, h, raw):
    def chunk(kind, data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',binascii.crc32(kind+data)&0xffffffff)
    rows=b''.join(b'\x00'+raw[y*w*4:(y+1)*w*4] for y in range(h))
    dest.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b''))
root = Path(__file__).resolve().parent.parent
port = int(__import__('sys').argv[1]) if len(__import__('sys').argv)>1 else 4773
state = __import__('sys').argv[2] if len(__import__('sys').argv)>2 else '/tmp/t3-tode-integration'
owned = os.environ.get('T3_TODE_SMOKE_OWNED') == '1'
default = os.environ.get('T3_TODE_SMOKE_DEFAULT') == '1'
url = ''
if not default and not owned:
    issued = subprocess.run(['node',str(root/'node_modules/t3/dist/bin.mjs'),'auth','pairing','create','--base-dir',state,'--base-url',f'http://127.0.0.1:{port}','--label','t3-tode smoke','--json'],capture_output=True,text=True,check=True)
    credential = json.loads(issued.stdout)
    # JSON format is documented by T3's auth CLI; keep the token out of logs.
    url = credential.get('pairUrl') or credential.get('pairingUrl') or credential.get('url')
    if not url:
        token = credential.get('token') or credential.get('credential')
        if not token: raise RuntimeError('Unrecognized pairing response keys: '+str(list(credential)))
        url = f'http://127.0.0.1:{port}/pair#token={token}'
    if os.environ.get('T3_TODE_SMOKE_REUSE') == '1': url = f'http://127.0.0.1:{port}/'
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH',50,160,1600,1000))
def session():
    os.setsid(); fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
env = dict(os.environ, TERM_PROGRAM='ghostty', TERM='xterm-ghostty', T3_TODE_URL=url, T3_TODE_PROFILE='/tmp/t3-tode-smoke-profile')
launch = ['node',str(root/'bin/t3-tode.mjs'),'--new-server','--port',str(port),'--state-dir',state,'--profile',str(Path(state)/'browser-profile')] if owned else ['node',str(root/'bin/t3-tode.mjs'),'--url',url,'--profile','/tmp/t3-tode-smoke-profile']
if default: launch = ['node',str(root/'bin/t3-tode.mjs'),'--profile','/tmp/t3-tode-existing-smoke']
proc = subprocess.Popen(launch,stdin=slave,stdout=slave,stderr=slave,env=env,preexec_fn=session,cwd=root)
os.close(slave)
buffer=b''; chunks=b''; meta={}; frames=0; last=None; deadline=time.monotonic()+float(os.environ.get('T3_TODE_SMOKE_SECONDS','20'))
try:
    while time.monotonic()<deadline and proc.poll() is None:
        if not select.select([master],[],[],.1)[0]: continue
        try: data=os.read(master,1024*1024)
        except OSError as error:
            if error.errno == 5: break  # Linux PTY EOF when child exits.
            raise
        if not data: break
        buffer+=data
        if b'\x1b[14t' in data: os.write(master,b'\x1b[4;1000;1600t')
        if b'\x1b[16t' in data: os.write(master,b'\x1b[6;20;10t')
        if b'\x1b[c' in data: os.write(master,b'\x1b[?1;2c')
        for match in re.finditer(rb'\x1b_G([^;]*);([^\x1b]*)\x1b\\',buffer):
            opts=dict(x.split('=',1) for x in match[1].decode().split(',') if '=' in x)
            if opts.get('a')=='q':
                if opts.get('i'):
                    reply = 'OK' if opts.get('t','d') == 'd' else 'ENOTSUP:direct transport only'
                    os.write(master,('\x1b_Gi='+opts['i']+';'+reply+'\x1b\\').encode())
                continue
            if opts.get('a') in ('T','t'):
                meta=opts; chunks=b''
            if not meta: continue
            chunks+=match[2]
            if opts.get('m','0')=='0':
                if meta.get('f')=='32' and meta.get('t','d')=='d':
                    try:
                        raw=base64.b64decode(chunks)
                        if meta.get('o')=='z': raw=zlib.decompress(raw)
                        w,h=int(meta['s']),int(meta['v'])
                        if w>=1000 and h>=600 and len(raw)==w*h*4:
                            last=(w,h,raw);frames+=1
                    except (KeyError,ValueError,zlib.error): pass
                meta={}; chunks=b''
        # Keep only incomplete escape sequences, never retain megabytes of frame data.
        end=buffer.rfind(b'\x1b\\')
        if end>=0: buffer=buffer[end+2:]
        elif len(buffer)>16*1024*1024: raise RuntimeError('Unbounded terminal frame')
    if last is None:
        detail=re.sub(r'([#?]token=)[^\s]+',r'\1[redacted]',buffer[-8000:].decode('utf8',errors='replace'))
        raise RuntimeError('No full Kitty graphics frame received. Terminal output: '+detail)
    dest=root/'artifacts/native-terminal.png';dest.parent.mkdir(exist_ok=True);save_png(dest,*last)
    os.write(master,b'\x11')  # Ctrl+Q: exercise terminal input and graceful shutdown.
    quit_deadline=time.monotonic()+10
    while proc.poll() is None and time.monotonic()<quit_deadline:
        if select.select([master],[],[],.1)[0]:
            try: os.read(master,1024*1024)
            except OSError: break
    proc.wait(timeout=5)
    if proc.returncode != 0: raise RuntimeError('Terminal did not quit cleanly: '+str(proc.returncode))
    print(json.dumps({'frames':frames,'resolution':last[:2],'exitCode':proc.returncode,'ownedBackend':owned,'artifact':str(dest)}))
finally:
    try: os.killpg(proc.pid,signal.SIGTERM)
    except ProcessLookupError: pass
    try: proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid,signal.SIGKILL);proc.wait()
    os.close(master)
