// IDE Relay Script — runs on the Sprite as a standalone Node.js process.
// Bridges Claude Code's local WebSocket IDE connection back to Obsidian
// via a TCP backhaul on port 9501, accessed through the Sprites proxy.
//
// Architecture:
//   Claude Code ←WS→ relay:9500 ←TCP→ relay:9501 ←proxy WS→ Obsidian
//
// Started as a background process via exec POST, uploaded via spriteManager.

export const IDE_RELAY_SCRIPT = `
'use strict';
process.on('uncaughtException', function(err) {
  try { require('fs').writeFileSync(require('path').join(process.env.HOME || '/home/sprite', '.claude', 'relay-crash.txt'), err.stack || String(err)); } catch(_) {}
  process.exit(1);
});
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLAUDE_PORT = 9502;
const OBSIDIAN_PORT = 9503;
const AUTH_TOKEN = crypto.randomUUID();
const BACKHAUL_TOKEN = crypto.randomUUID();
const WORK_DIR = '/home/sprite/obsidian';
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB max buffer per connection
const MAX_PENDING_MESSAGES = 100;

let claudeSocket = null;
let obsidianSocket = null;
let fragments = [];

// --- WebSocket framing (minimal, no deps) ---

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0F;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7F;
  let offset = 2;
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
    const mask = buf.slice(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(buf.slice(offset, offset + payloadLen));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    return { fin, opcode, payload, totalLength: offset + payloadLen };
  }
  if (buf.length < offset + payloadLen) return null;
  return { fin, opcode, payload: buf.slice(offset, offset + payloadLen), totalLength: offset + payloadLen };
}

function makeFrame(data, opcode) {
  opcode = opcode || 0x01;
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const len = payload.length;
  let header;
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

// --- Lock file ---

function writeLockFile() {
  const lockDir = path.join(process.env.HOME || '/home/sprite', '.claude', 'ide');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, String(CLAUDE_PORT) + '.lock');
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    workspaceFolders: [WORK_DIR],
    ideName: 'Obsidian',
    transport: 'ws',
    authToken: AUTH_TOKEN,
    backhaulToken: BACKHAUL_TOKEN
  }));
  return lockPath;
}

function removeLockFile(lockPath) {
  try { fs.unlinkSync(lockPath); } catch (_) {}
}

// Buffer messages until Obsidian connects
let pendingMessages = [];
let flushTimer = null;

function log(s) { process.stderr.write('[Relay] ' + s + '\\n'); }

// Forward a message from Claude Code to Obsidian (via TCP backhaul)
function toObsidian(msg) {
  if (msg.length > MAX_BUFFER_SIZE) {
    log('dropping oversized message: ' + msg.length + ' bytes');
    return;
  }
  if (obsidianSocket && !obsidianSocket.destroyed) {
    obsidianSocket.write(msg + '\\n');
  } else {
    if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
      log('pending buffer full, dropping oldest');
      pendingMessages.shift();
    }
    pendingMessages.push(msg);
  }
}

// Flush buffered messages when Obsidian connects
function flushPending() {
  log('flushPending: pending=' + pendingMessages.length + ' socket=' + (obsidianSocket && !obsidianSocket.destroyed ? 'ok' : 'none'));
  if (obsidianSocket && !obsidianSocket.destroyed && pendingMessages.length > 0) {
    for (let i = 0; i < pendingMessages.length; i++) {
      log('flushing msg ' + i + ': ' + pendingMessages[i].substring(0, 80));
      obsidianSocket.write(pendingMessages[i] + '\\n');
    }
    pendingMessages = [];
  }
}

// --- WebSocket server (port 9500) — Claude Code connects here ---

const wsServer = http.createServer(function(_, res) { res.writeHead(404); res.end(); });

wsServer.on('upgrade', function(req, socket) {
  const auth = req.headers['x-claude-code-ide-authorization'];
  if (auth !== AUTH_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\\r\\n' +
    'Upgrade: websocket\\r\\n' +
    'Connection: Upgrade\\r\\n' +
    'Sec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n'
  );

  log('Claude Code connected');
  claudeSocket = socket;
  fragments = [];
  let buffer = Buffer.alloc(0);

  socket.on('data', function(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const frame = parseFrame(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.totalLength);

      if (frame.opcode === 0x08) {
        try { socket.write(makeFrame(Buffer.alloc(0), 0x08)); } catch (_) {}
        socket.destroy();
        claudeSocket = null;
        return;
      }
      if (frame.opcode === 0x09) {
        try { socket.write(makeFrame(frame.payload, 0x0A)); } catch (_) {}
        continue;
      }
      if (frame.opcode === 0x0A) continue;

      if (frame.opcode === 0x00) {
        fragments.push(frame.payload);
        if (frame.fin) {
          const full = Buffer.concat(fragments);
          fragments = [];
          toObsidian(full.toString('utf-8'));
        }
        continue;
      }

      if (frame.opcode === 0x01) {
        if (frame.fin) {
          toObsidian(frame.payload.toString('utf-8'));
        } else {
          fragments = [frame.payload];
        }
      }
    }
  });

  socket.on('close', function() { claudeSocket = null; });
  socket.on('error', function() { claudeSocket = null; });
});

// --- TCP server (port 9503) — Obsidian connects here via Sprites proxy ---

const tcpServer = net.createServer(function(socket) {
  log('TCP connection received, pending: ' + pendingMessages.length);
  let authenticated = false;
  let buf = '';
  let bufSize = 0;
  socket.setEncoding('utf-8');

  socket.on('data', function(chunk) {
    bufSize += chunk.length;
    if (bufSize > MAX_BUFFER_SIZE) {
      log('TCP buffer overflow, closing');
      socket.destroy();
      return;
    }
    buf += chunk;
    const lines = buf.split('\\n');
    buf = lines.pop();

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;

      // First message must be auth handshake
      if (!authenticated) {
        try {
          var authMsg = JSON.parse(lines[i]);
          if (authMsg.type === 'auth' && authMsg.token === BACKHAUL_TOKEN) {
            authenticated = true;
            obsidianSocket = socket;
            socket.write(JSON.stringify({ type: 'auth_ok' }) + '\\n');
            // Sprites proxy may create multiple TCP connections in quick succession.
            // Delay flush so the final connection gets the buffered messages.
            if (flushTimer) clearTimeout(flushTimer);
            flushTimer = setTimeout(function() {
              flushTimer = null;
              flushPending();
            }, 500);
            continue;
          }
        } catch (_) {}
        log('TCP auth failed, closing');
        socket.destroy();
        return;
      }

      if (claudeSocket) {
        try { claudeSocket.write(makeFrame(lines[i])); } catch (_) {}
      }
    }
  });

  socket.on('close', function() { if (obsidianSocket === socket) obsidianSocket = null; });
  socket.on('error', function() { if (obsidianSocket === socket) obsidianSocket = null; });
});

// --- Start ---

const lockPath = writeLockFile();

process.on('exit', function() { removeLockFile(lockPath); });
process.on('SIGTERM', function() { process.exit(); });
process.on('SIGINT', function() { process.exit(); });

wsServer.listen(CLAUDE_PORT, '127.0.0.1', function() {
  process.stderr.write('[IDE Relay] WS server on port ' + CLAUDE_PORT + '\\n');
  tcpServer.listen(OBSIDIAN_PORT, '127.0.0.1', function() {
    process.stderr.write('[IDE Relay] TCP backhaul on port ' + OBSIDIAN_PORT + '\\n');
  });
});
`;
