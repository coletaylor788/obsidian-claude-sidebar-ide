#!/usr/bin/env node
// mcp-relay.js — MCP bridge for remote IDE integration
// Runs on the Sprite VM. Pure Node.js, zero dependencies.
//
// Two roles:
// 1. IDE Server on localhost:IDE_PORT — Claude Code connects here via lock file
// 2. Relay Listener on port 9500 — Mobile client connects via Sprites Proxy API
//
// Bridges JSON-RPC messages bidirectionally between them.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IDE_PORT = parseInt(process.env.CLAUDE_CODE_SSE_PORT || '9501', 10);
const RELAY_PORT = 9500;
const AUTH_TOKEN = crypto.randomUUID();

// Track connected clients
let claudeSocket = null;
let mobileSocket = null;

// --- WebSocket helpers (minimal RFC 6455) ---

function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLen) return null;

  let payload = buffer.slice(offset, offset + payloadLen);
  if (masked && maskKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }

  return { fin, opcode, payload, totalLength: offset + payloadLen };
}

function makeFrame(data, opcode = 0x01) {
  const payload = typeof data === 'string' ? Buffer.from(data) : data;
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

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5AB5AAFB43B6';

function upgradeConnection(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return false;
  }
  const accept = crypto.createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  return true;
}

// --- IDE Server (Claude Code connects here) ---

const ideServer = http.createServer((_req, res) => {
  res.writeHead(404);
  res.end();
});

ideServer.on('upgrade', (req, socket) => {
  // Validate auth token
  const authHeader = req.headers['x-claude-code-ide-authorization'];
  if (authHeader !== AUTH_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!upgradeConnection(req, socket)) return;

  claudeSocket = { socket, buffer: Buffer.alloc(0) };
  console.log('[mcp-relay] Claude Code connected');

  socket.on('data', (data) => {
    claudeSocket.buffer = Buffer.concat([claudeSocket.buffer, data]);
    processFrames(claudeSocket, 'claude');
  });

  socket.on('close', () => {
    console.log('[mcp-relay] Claude Code disconnected');
    claudeSocket = null;
  });

  socket.on('error', () => {
    claudeSocket = null;
  });
});

// --- Relay Server (Mobile client connects here via Sprites Proxy) ---

const relayServer = http.createServer((_req, res) => {
  res.writeHead(404);
  res.end();
});

relayServer.on('upgrade', (req, socket) => {
  if (!upgradeConnection(req, socket)) return;

  mobileSocket = { socket, buffer: Buffer.alloc(0) };
  console.log('[mcp-relay] Mobile client connected');

  socket.on('data', (data) => {
    mobileSocket.buffer = Buffer.concat([mobileSocket.buffer, data]);
    processFrames(mobileSocket, 'mobile');
  });

  socket.on('close', () => {
    console.log('[mcp-relay] Mobile client disconnected');
    mobileSocket = null;
  });

  socket.on('error', () => {
    mobileSocket = null;
  });
});

// --- Frame processing and bridging ---

function processFrames(client, source) {
  while (true) {
    const frame = parseFrame(client.buffer);
    if (!frame) break;
    client.buffer = client.buffer.slice(frame.totalLength);

    // Close frame
    if (frame.opcode === 0x08) {
      try { client.socket.write(makeFrame(Buffer.alloc(0), 0x08)); } catch (_e) {}
      client.socket.destroy();
      if (source === 'claude') claudeSocket = null;
      else mobileSocket = null;
      return;
    }

    // Ping → Pong
    if (frame.opcode === 0x09) {
      try { client.socket.write(makeFrame(frame.payload, 0x0a)); } catch (_e) {}
      continue;
    }

    // Pong — ignore
    if (frame.opcode === 0x0a) continue;

    // Text frame — bridge to other side
    if (frame.opcode === 0x01 && frame.fin) {
      const target = source === 'claude' ? mobileSocket : claudeSocket;
      if (target) {
        try {
          target.socket.write(makeFrame(frame.payload));
        } catch (_e) {}
      }
    }
  }
}

// --- Write lock file for Claude Code discovery ---

function writeLockFile() {
  const lockDir = path.join(os.homedir(), '.claude', 'ide');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${IDE_PORT}.lock`);
  const lockData = {
    pid: process.pid,
    workspaceFolders: [process.cwd()],
    ideName: 'Obsidian',
    transport: 'ws',
    authToken: AUTH_TOKEN,
  };
  fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2));
  return lockPath;
}

// --- Start ---

const lockPath = writeLockFile();
console.log(`[mcp-relay] Lock file: ${lockPath}`);

ideServer.listen(IDE_PORT, '127.0.0.1', () => {
  console.log(`[mcp-relay] IDE server on port ${IDE_PORT}`);
});

relayServer.listen(RELAY_PORT, '0.0.0.0', () => {
  console.log(`[mcp-relay] Relay server on port ${RELAY_PORT}`);
});

// Cleanup on exit
process.on('SIGTERM', () => {
  try { fs.unlinkSync(lockPath); } catch (_e) {}
  process.exit(0);
});

process.on('SIGINT', () => {
  try { fs.unlinkSync(lockPath); } catch (_e) {}
  process.exit(0);
});
