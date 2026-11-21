import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {WebSocketServer, WebSocket} from 'ws';

type DeviceType = 'desktop' | 'mobile' | 'tablet';

interface ClientRecord {
  id: string;
  name: string;
  deviceType: DeviceType;
  roomCode: string;
  ws: WebSocket;
}

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const rooms = new Map<string, Map<string, ClientRecord>>();
const clients = new Map<WebSocket, ClientRecord>();

function normalizeRoomCode(raw?: string): string {
  if (!raw) return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function generateRoomCode(): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function generateClientId(): string {
  return crypto.randomBytes(6).toString('hex');
}

function getRoomPeers(roomCode: string) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  return Array.from(room.values()).map((c) => ({
    id: c.id,
    name: c.name,
    deviceType: c.deviceType,
  }));
}

function sendJson(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastRoomPeers(roomCode: string): void {
  const room = rooms.get(roomCode);
  if (!room) return;
  const peers = getRoomPeers(roomCode);
  const payload = JSON.stringify({type: 'room:peers', peers});
  for (const member of room.values()) {
    if (member.ws.readyState === WebSocket.OPEN) {
      member.ws.send(payload);
    }
  }
}

function leaveCurrentRoom(client: ClientRecord): void {
  const prevRoom = rooms.get(client.roomCode);
  if (!prevRoom) return;
  prevRoom.delete(client.id);
  if (prevRoom.size === 0) {
    rooms.delete(client.roomCode);
  } else {
    broadcastRoomPeers(client.roomCode);
  }
}

function handleTextMessage(ws: WebSocket, raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const type = typeof msg.type === 'string' ? msg.type : '';

  if (type === 'join') {
    const existing = clients.get(ws);
    if (existing) {
      leaveCurrentRoom(existing);
    }

    const requestedCode = normalizeRoomCode(
      typeof msg.roomCode === 'string' ? msg.roomCode : undefined,
    );
    const roomCode = requestedCode.length >= 4 ? requestedCode : generateRoomCode();
    const id =
      existing?.id ||
      (typeof msg.clientId === 'string' && msg.clientId.length > 0 && msg.clientId.length <= 32
        ? msg.clientId
        : generateClientId());
    const name =
      typeof msg.name === 'string' && msg.name.trim().length > 0
        ? msg.name.trim().slice(0, 48)
        : 'Device';
    const deviceType: DeviceType =
      msg.deviceType === 'mobile' || msg.deviceType === 'tablet' ? msg.deviceType : 'desktop';

    const record: ClientRecord = {id, name, deviceType, roomCode, ws};
    clients.set(ws, record);

    let room = rooms.get(roomCode);
    if (!room) {
      room = new Map();
      rooms.set(roomCode, room);
    }
    room.set(id, record);

    sendJson(ws, {
      type: 'joined',
      clientId: id,
      roomCode,
      peers: getRoomPeers(roomCode),
    });
    broadcastRoomPeers(roomCode);
    return;
  }

  const sender = clients.get(ws);
  if (!sender) return;

  if (type === 'rename') {
    const nextName = typeof msg.name === 'string' ? msg.name.trim().slice(0, 48) : '';
    if (nextName) {
      sender.name = nextName;
      broadcastRoomPeers(sender.roomCode);
    }
    return;
  }

  if (
    type === 'rtc:offer' ||
    type === 'rtc:answer' ||
    type === 'rtc:ice' ||
    type === 'signal'
  ) {
    const to = typeof msg.to === 'string' ? msg.to : '';
    if (!to) return;
    const room = rooms.get(sender.roomCode);
    const target = room?.get(to);
    if (!target || target.ws.readyState !== WebSocket.OPEN) return;

    sendJson(target.ws, {
      type,
      from: sender.id,
      payload: msg.payload,
    });
  }
}

function handleBinaryRelay(ws: WebSocket, data: Buffer): void {
  const sender = clients.get(ws);
  if (!sender || data.length < 4) return;

  const frameType = data[0];
  if (frameType !== 1) return;

  const targetIdLen = data[1];
  const transferIdLen = data[2];
  const headerLen = 3 + targetIdLen + transferIdLen;
  if (data.length < headerLen) return;

  const targetId = data.subarray(3, 3 + targetIdLen).toString('utf8');
  const transferIdBytes = data.subarray(3 + targetIdLen, headerLen);
  const chunkPayload = data.subarray(headerLen);

  const room = rooms.get(sender.roomCode);
  const target = room?.get(targetId);
  if (!target || target.ws.readyState !== WebSocket.OPEN) return;

  const senderIdBytes = Buffer.from(sender.id, 'utf8');
  const out = Buffer.allocUnsafe(3 + senderIdBytes.length + transferIdBytes.length + chunkPayload.length);
  out[0] = 1;
  out[1] = senderIdBytes.length;
  out[2] = transferIdBytes.length;
  senderIdBytes.copy(out, 3);
  transferIdBytes.copy(out, 3 + senderIdBytes.length);
  chunkPayload.copy(out, 3 + senderIdBytes.length + transferIdBytes.length);

  target.ws.send(out, {binary: true});
}

async function startServer(): Promise<void> {
  const app = express();
  app.get('/api/health', (_req, res) => {
    res.json({ok: true});
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 10 * 1024 * 1024,
  });

  wss.on('connection', (ws) => {
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 25000);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        handleBinaryRelay(ws, buf);
      } else {
        handleTextMessage(ws, data.toString('utf8'));
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      const client = clients.get(ws);
      if (client) {
        clients.delete(ws);
        leaveCurrentRoom(client);
      }
    });
  });

  server.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (reqUrl.pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Relay server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
