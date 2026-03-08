// Terminal Server Script — runs on the Sprite as a Sprites service.
// Provides WebSocket endpoints for terminal PTY, IDE relay proxy, and file watching.
// Auth via ticket-based system: master secret → one-time tickets → WS connection.
//
// Endpoints:
//   POST /api/ticket       — generate one-time WS ticket (requires master secret)
//   WS   /ws?ticket=&cols=&rows= — terminal PTY session
//   WS   /ide?ticket=      — TCP proxy to IDE relay on localhost:9503
//   WS   /watch?ticket=    — filesystem change notifications
//
// Registered as a Sprites service on port 8080.
// Started automatically by the Sprites service manager.

export const PTY_HELPER_SCRIPT = `#!/usr/bin/env python3
"""Minimal PTY helper. Creates a bash PTY and forwards stdin/stdout.
Resize via SIGUSR1 + /tmp/.pty-resize-{pid} file."""
import pty,os,sys,select,struct,fcntl,termios,signal
cols=int(os.environ.get('COLS','80'))
rows=int(os.environ.get('ROWS','24'))
wd=os.environ.get('WORKDIR',os.getcwd())
mfd,sfd=pty.openpty()
fcntl.ioctl(mfd,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
pid=os.fork()
if pid==0:
    os.close(mfd);os.setsid()
    fcntl.ioctl(sfd,termios.TIOCSCTTY,0)
    os.dup2(sfd,0);os.dup2(sfd,1);os.dup2(sfd,2);os.close(sfd)
    try:os.chdir(wd)
    except:pass
    e=dict(os.environ);e['TERM']='xterm-256color'
    os.execvpe('bash',['bash'],e)
os.close(sfd)
def do_resize(r,c):
    try:
        fcntl.ioctl(mfd,termios.TIOCSWINSZ,struct.pack('HHHH',r,c,0,0))
        os.kill(pid,signal.SIGWINCH)
    except:pass
def on_usr1(sig,frame):
    try:
        with open('/tmp/.pty-resize-'+str(os.getpid())) as f:
            p=f.read().strip().split(',')
            do_resize(int(p[0]),int(p[1]))
    except:pass
signal.signal(signal.SIGUSR1,on_usr1)
while True:
    try:rl,_,_=select.select([mfd,0],[],[],1.0)
    except:break
    if mfd in rl:
        try:
            d=os.read(mfd,65536)
            if not d:break
            sys.stdout.buffer.write(d);sys.stdout.buffer.flush()
        except OSError:break
    if 0 in rl:
        try:
            d=os.read(0,65536)
            if not d:break
            os.write(mfd,d)
        except OSError:break
    try:
        p,s=os.waitpid(pid,os.WNOHANG)
        if p:break
    except:pass
try:os.close(mfd)
except:pass
code=0
try:_,s=os.waitpid(pid,0);code=os.WEXITSTATUS(s) if os.WIFEXITED(s) else 1
except:pass
sys.exit(code)
`;

export const TERMINAL_SERVER_SCRIPT = `
'use strict';
process.on('uncaughtException', function(err) {
  try {
    require('fs').writeFileSync('/tmp/terminal-server-crash.txt', err.stack || String(err));
  } catch(_) {}
  process.exit(1);
});

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TICKET_TTL = 60000; // 60 seconds
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB
const WORK_DIR = '/home/sprite/obsidian';
const SECRET_DIR = '/home/sprite/.ws-terminal';
const SECRET_PATH = SECRET_DIR + '/master-secret';
const LOCK_FILE = '/home/sprite/.claude/ide/9502.lock';

// --- Master Secret ---

const MASTER_SECRET = crypto.randomUUID();
fs.mkdirSync(SECRET_DIR, { recursive: true });
fs.writeFileSync(SECRET_PATH, MASTER_SECRET);

// --- Ticket Store ---

const tickets = new Map(); // ticket -> { created: number }

function createTicket() {
  // Clean expired tickets
  const now = Date.now();
  for (const [t, v] of tickets) {
    if (now - v.created > TICKET_TTL) tickets.delete(t);
  }
  const ticket = crypto.randomUUID();
  tickets.set(ticket, { created: now });
  return ticket;
}

function validateTicket(ticket) {
  if (!ticket) return false;
  const data = tickets.get(ticket);
  if (!data) return false;
  if (Date.now() - data.created > TICKET_TTL) {
    tickets.delete(ticket);
    return false;
  }
  tickets.delete(ticket); // One-time use
  return true;
}

// --- WebSocket Framing (minimal, no deps) ---

function parseFrame(buf) {
  if (buf.length < 2) return null;
  var fin = (buf[0] & 0x80) !== 0;
  var opcode = buf[0] & 0x0F;
  var masked = (buf[1] & 0x80) !== 0;
  var payloadLen = buf[1] & 0x7F;
  var offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null;
    var mask = buf.slice(offset, offset + 4);
    offset += 4;
    var payload = Buffer.from(buf.slice(offset, offset + payloadLen));
    for (var i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    return { fin: fin, opcode: opcode, payload: payload, totalLength: offset + payloadLen };
  }
  if (buf.length < offset + payloadLen) return null;
  return { fin: fin, opcode: opcode, payload: buf.slice(offset, offset + payloadLen), totalLength: offset + payloadLen };
}

function makeFrame(data, opcode) {
  opcode = opcode || 0x01;
  var payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  var len = payload.length;
  var header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsHandshake(req, socket) {
  var key = req.headers['sec-websocket-key'];
  if (!key) return false;
  var accept = crypto.createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\\r\\n' +
    'Upgrade: websocket\\r\\n' +
    'Connection: Upgrade\\r\\n' +
    'Sec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n'
  );
  return true;
}

// Read WS frames from a raw socket, call onMessage(payload_string) for text frames
function attachWsReader(socket, onMessage, onClose) {
  var buffer = Buffer.alloc(0);
  var fragments = [];

  socket.on('data', function(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_BUFFER_SIZE) {
      log('buffer overflow, closing');
      socket.destroy();
      return;
    }
    while (buffer.length >= 2) {
      var frame = parseFrame(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.totalLength);

      if (frame.opcode === 0x08) { // close
        try { socket.write(makeFrame(Buffer.alloc(0), 0x08)); } catch(_) {}
        socket.destroy();
        return;
      }
      if (frame.opcode === 0x09) { // ping
        try { socket.write(makeFrame(frame.payload, 0x0A)); } catch(_) {}
        continue;
      }
      if (frame.opcode === 0x0A) continue; // pong

      if (frame.opcode === 0x00) { // continuation
        fragments.push(frame.payload);
        if (frame.fin) {
          var full = Buffer.concat(fragments);
          fragments = [];
          onMessage(full.toString('utf-8'));
        }
        continue;
      }

      if (frame.opcode === 0x01 || frame.opcode === 0x02) { // text or binary
        if (frame.fin) {
          onMessage(frame.payload.toString('utf-8'));
        } else {
          fragments = [frame.payload];
        }
      }
    }
  });

  socket.on('close', function() { if (onClose) onClose(); });
  socket.on('error', function() { if (onClose) onClose(); });
}

function log(s) { process.stderr.write('[TermServer] ' + s + '\\n'); }

// --- PTY Session Handler (/ws) ---

function handleTerminalSession(req, socket) {
  if (!wsHandshake(req, socket)) {
    socket.write('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
    socket.destroy();
    return;
  }

  var url = new URL(req.url, 'http://localhost');
  var cols = parseInt(url.searchParams.get('cols') || '80', 10);
  var rows = parseInt(url.searchParams.get('rows') || '24', 10);

  var pty;
  try {
    pty = require('node-pty');
  } catch(e) {
    pty = null;
  }

  if (pty) {
    // -- node-pty path --
    var ptyProcess = pty.spawn('bash', [], {
      name: 'xterm-256color',
      cols: cols,
      rows: rows,
      cwd: WORK_DIR,
      env: Object.assign({}, process.env, { TERM: 'xterm-256color' })
    });

    log('PTY spawned (node-pty), pid=' + ptyProcess.pid + ' cols=' + cols + ' rows=' + rows);

    ptyProcess.onData(function(data) {
      try {
        socket.write(makeFrame(JSON.stringify({ type: 'data', data: data })));
      } catch(_) {}
    });

    ptyProcess.onExit(function(e) {
      log('PTY exited, code=' + e.exitCode);
      try {
        socket.write(makeFrame(JSON.stringify({ type: 'exit', exit_code: e.exitCode })));
      } catch(_) {}
      socket.destroy();
    });

    attachWsReader(socket, function(text) {
      if (text.length > 2 && text[0] === '{') {
        try {
          var msg = JSON.parse(text);
          if (msg.__ctrl === 'resize' && msg.cols && msg.rows) {
            ptyProcess.resize(msg.cols, msg.rows);
            log('resize: ' + msg.cols + 'x' + msg.rows);
            return;
          }
        } catch(_) {}
      }
      ptyProcess.write(text);
    }, function() {
      try { ptyProcess.kill(); } catch(_) {}
    });

  } else {
    // -- Python PTY fallback (no native compilation needed) --
    log('node-pty not available, using Python PTY fallback');
    var cp = require('child_process');
    var proc = cp.spawn('python3', ['/home/sprite/.ws-terminal/pty-helper.py'], {
      env: Object.assign({}, process.env, {
        COLS: String(cols),
        ROWS: String(rows),
        WORKDIR: WORK_DIR,
        TERM: 'xterm-256color'
      }),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    log('PTY spawned (python), pid=' + proc.pid + ' cols=' + cols + ' rows=' + rows);

    proc.stdout.on('data', function(data) {
      try {
        socket.write(makeFrame(JSON.stringify({ type: 'data', data: data.toString('utf-8') })));
      } catch(_) {}
    });

    proc.stderr.on('data', function(data) {
      log('python pty stderr: ' + data.toString().trim());
    });

    proc.on('exit', function(code) {
      log('Python PTY exited, code=' + code);
      try {
        socket.write(makeFrame(JSON.stringify({ type: 'exit', exit_code: code || 0 })));
      } catch(_) {}
      socket.destroy();
    });

    proc.on('error', function(err) {
      log('Python PTY spawn error: ' + err.message);
      try {
        socket.write(makeFrame(JSON.stringify({ type: 'data', data: '[Error: failed to start PTY: ' + err.message + ']\\r\\n' })));
        socket.write(makeFrame(JSON.stringify({ type: 'exit', exit_code: 1 })));
      } catch(_) {}
      socket.destroy();
    });

    attachWsReader(socket, function(text) {
      if (text.length > 2 && text[0] === '{') {
        try {
          var msg = JSON.parse(text);
          if (msg.__ctrl === 'resize' && msg.cols && msg.rows) {
            try {
              fs.writeFileSync('/tmp/.pty-resize-' + proc.pid, msg.rows + ',' + msg.cols);
              proc.kill('SIGUSR1');
            } catch(_) {}
            log('resize (python): ' + msg.cols + 'x' + msg.rows);
            return;
          }
        } catch(_) {}
      }
      try { proc.stdin.write(text); } catch(_) {}
    }, function() {
      try { proc.kill(); } catch(_) {}
    });
  }
}

// --- IDE Relay Proxy Handler (/ide) ---

function handleIdeProxy(req, socket) {
  if (!wsHandshake(req, socket)) {
    socket.write('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
    socket.destroy();
    return;
  }

  // Read backhaul token from IDE relay lock file
  var backhaulToken = null;
  try {
    var lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    backhaulToken = lockData.backhaulToken || null;
  } catch(_) {
    log('IDE lock file not found — relay may not be running');
  }

  // Connect to IDE relay TCP backhaul on localhost:9503
  var tcp = new net.Socket();
  var tcpConnected = false;
  var tcpBuffer = '';
  var retries = 0;
  var maxRetries = 3;

  function connectTcp() {
    tcp = new net.Socket();

    tcp.connect(9503, '127.0.0.1', function() {
      tcpConnected = true;
      log('IDE proxy: TCP connected to relay');

      // Send auth handshake
      if (backhaulToken) {
        tcp.write(JSON.stringify({ type: 'auth', token: backhaulToken }) + '\\n');
      }
    });

    tcp.setEncoding('utf-8');

    tcp.on('data', function(chunk) {
      tcpBuffer += chunk;
      var lines = tcpBuffer.split('\\n');
      tcpBuffer = lines.pop() || '';

      for (var i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;

        // Skip auth_ok — don't forward to client
        try {
          var msg = JSON.parse(lines[i]);
          if (msg.type === 'auth_ok') {
            log('IDE proxy: auth OK');
            continue;
          }
        } catch(_) {}

        // Forward to WS client
        try {
          socket.write(makeFrame(lines[i]));
        } catch(_) {}
      }
    });

    tcp.on('error', function(err) {
      log('IDE proxy TCP error: ' + err.message);
      if (!tcpConnected && retries < maxRetries) {
        retries++;
        log('IDE proxy: retry ' + retries + '/' + maxRetries);
        setTimeout(connectTcp, 500);
      }
    });

    tcp.on('close', function() {
      tcpConnected = false;
    });
  }

  connectTcp();

  // WS input -> TCP relay
  attachWsReader(socket, function(text) {
    if (tcpConnected && !tcp.destroyed) {
      tcp.write(text + '\\n');
    }
  }, function() {
    // WS closed — close TCP
    tcp.destroy();
  });
}

// --- File Watch Handler (/watch) ---

function handleFileWatch(req, socket) {
  if (!wsHandshake(req, socket)) {
    socket.write('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
    socket.destroy();
    return;
  }

  var url = new URL(req.url, 'http://localhost');
  var watchPath = url.searchParams.get('path') || WORK_DIR;
  var watcher = null;
  var closed = false;

  function startWatcher(dir) {
    if (watcher) {
      try { watcher.close(); } catch(_) {}
    }
    try {
      watcher = fs.watch(dir, { recursive: true }, function(eventType, filename) {
        if (closed || !filename) return;
        var fullPath = path.join(dir, filename);
        var event = eventType === 'rename' ? 'rename' : 'change';

        // Check if file exists to determine if it was created/modified or deleted
        var isDir = false;
        try {
          var stat = fs.statSync(fullPath);
          isDir = stat.isDirectory();
        } catch(_) {
          event = 'delete';
        }

        try {
          socket.write(makeFrame(JSON.stringify({
            type: 'watch_event',
            event: event,
            path: fullPath,
            isDir: isDir
          })));
        } catch(_) {}
      });
      log('watching: ' + dir);
    } catch(e) {
      log('watch failed: ' + e.message);
    }
  }

  // Handle subscribe messages from client
  attachWsReader(socket, function(text) {
    try {
      var msg = JSON.parse(text);
      if (msg.type === 'subscribe' && msg.paths && msg.paths.length > 0) {
        startWatcher(msg.paths[0]);
      }
    } catch(_) {}
  }, function() {
    closed = true;
    if (watcher) {
      try { watcher.close(); } catch(_) {}
    }
  });

  // Start watching the default path immediately
  startWatcher(watchPath);
}

// --- HTTP Server ---

var server = http.createServer(function(req, res) {
  // CORS headers for requestUrl compatibility
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ticket') {
    var body = '';
    req.on('data', function(chunk) {
      body += chunk;
      if (body.length > 4096) {
        res.writeHead(413);
        res.end('Too large');
        req.destroy();
      }
    });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (data.secret !== MASTER_SECRET) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid secret' }));
          return;
        }
        var ticket = createTicket();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ticket: ticket }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// --- WebSocket Upgrade ---

server.on('upgrade', function(req, socket) {
  var url = new URL(req.url, 'http://localhost');
  var ticket = url.searchParams.get('ticket');

  if (!validateTicket(ticket)) {
    socket.write('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');
    socket.destroy();
    return;
  }

  var pathname = url.pathname;

  if (pathname === '/ws') {
    handleTerminalSession(req, socket);
  } else if (pathname === '/ide') {
    handleIdeProxy(req, socket);
  } else if (pathname === '/watch') {
    handleFileWatch(req, socket);
  } else {
    socket.write('HTTP/1.1 404 Not Found\\r\\n\\r\\n');
    socket.destroy();
  }
});

// --- Start ---

server.listen(PORT, '0.0.0.0', function() {
  log('listening on port ' + PORT);
  log('master secret written to ' + SECRET_PATH);
});
`;
