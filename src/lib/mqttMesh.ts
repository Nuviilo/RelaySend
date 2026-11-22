import type {DeviceType, PeerInfo} from '../types';

const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];
const TOPIC_PREFIX = 'relay-share/v1';
const PRESENCE_INTERVAL_MS = 7000;
const PEER_TTL_MS = 20000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeRemainingLength(len: number): number[] {
  const bytes: number[] = [];
  let x = len;
  do {
    let encoded = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) encoded |= 128;
    bytes.push(encoded);
  } while (x > 0);
  return bytes;
}

function encodeMqttString(str: string): Uint8Array<ArrayBuffer> {
  const raw = textEncoder.encode(str);
  const out = new Uint8Array(2 + raw.length);
  out[0] = (raw.length >> 8) & 0xff;
  out[1] = raw.length & 0xff;
  out.set(raw, 2);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function buildConnectPacket(mqttClientId: string, keepAliveSec = 30): Uint8Array<ArrayBuffer> {
  const varHeader = new Uint8Array([
    0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, // "MQTT"
    0x04, // MQTT 3.1.1
    0x02, // Clean session
    (keepAliveSec >> 8) & 0xff,
    keepAliveSec & 0xff,
  ]);
  const payload = encodeMqttString(mqttClientId);
  const remLen = new Uint8Array(encodeRemainingLength(varHeader.length + payload.length));
  return concatBytes([new Uint8Array([0x10]), remLen, varHeader, payload]);
}

function buildSubscribePacket(packetId: number, topics: string[]): Uint8Array<ArrayBuffer> {
  const varHeader = new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]);
  const topicParts: Uint8Array[] = [];
  for (const topic of topics) {
    topicParts.push(encodeMqttString(topic), new Uint8Array([0x00]));
  }
  const payload = concatBytes(topicParts);
  const remLen = new Uint8Array(encodeRemainingLength(varHeader.length + payload.length));
  return concatBytes([new Uint8Array([0x82]), remLen, varHeader, payload]);
}

function buildPublishPacket(topic: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const varHeader = encodeMqttString(topic);
  const remLen = new Uint8Array(encodeRemainingLength(varHeader.length + payload.length));
  return concatBytes([new Uint8Array([0x30]), remLen, varHeader, payload]);
}

export interface MqttInboxInvite {
  from: string;
  name: string;
  deviceType: DeviceType;
  roomCode: string;
}

export interface MqttMeshCallbacks {
  onPeersChange: (peers: PeerInfo[]) => void;
  onDirectJson: (from: string, data: Record<string, unknown>) => void;
  onDirectBinary: (from: string, transferId: string, chunk: Uint8Array<ArrayBuffer>) => void;
  onInboxInvite: (invite: MqttInboxInvite) => void;
  onStatusChange: (connected: boolean) => void;
}

interface TrackedPeer extends PeerInfo {
  lastSeen: number;
}

export class MqttMesh {
  private ws: WebSocket | null = null;
  private brokerIdx = 0;
  private destroyed = false;
  private connected = false;
  private rxBuffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private pingTimer: number | null = null;
  private presenceTimer: number | null = null;
  private pruneTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private packetIdSeq = 1;

  private clientId: string;
  private deviceName: string;
  private deviceType: DeviceType;
  private roomCode: string;
  private peers = new Map<string, TrackedPeer>();
  private callbacks: MqttMeshCallbacks;

  constructor(options: {
    clientId: string;
    name: string;
    deviceType: DeviceType;
    roomCode: string;
    callbacks: MqttMeshCallbacks;
  }) {
    this.clientId = options.clientId;
    this.deviceName = options.name;
    this.deviceType = options.deviceType;
    this.roomCode = options.roomCode;
    this.callbacks = options.callbacks;
  }

  start(): void {
    if (this.destroyed) return;
    this.connectNext();
    if (this.pruneTimer === null) {
      this.pruneTimer = window.setInterval(() => this.pruneExpiredPeers(), 5000);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.publishBye();
    this.clearTimers();
    if (this.pruneTimer !== null) {
      window.clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.peers.clear();
  }

  setRoomCode(nextCode: string): void {
    if (!nextCode) return;
    if (nextCode === this.roomCode) {
      this.emitPeers();
      if (this.connected) {
        this.publishPresence();
      }
      return;
    }
    this.publishBye();
    this.roomCode = nextCode;
    this.peers.clear();
    this.callbacks.onPeersChange([]);
    if (this.connected) {
      this.subscribeCurrentRoom();
      this.publishPresence();
    }
  }

  setDeviceName(name: string): void {
    this.deviceName = name;
    if (this.connected) {
      this.publishPresence();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  sendDirectJson(to: string, data: Record<string, unknown>): boolean {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const topic = `${TOPIC_PREFIX}/${this.roomCode}/to/${to}`;
    const payload = textEncoder.encode(
      JSON.stringify({
        ...data,
        from: this.clientId,
      }),
    );
    this.ws.send(buildPublishPacket(topic, payload));
    return true;
  }

  sendDirectBinary(to: string, transferId: string, chunk: Uint8Array): boolean {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const topic = `${TOPIC_PREFIX}/${this.roomCode}/bin/${to}`;
    const fromBytes = textEncoder.encode(this.clientId);
    const tidBytes = textEncoder.encode(transferId);
    const payload = new Uint8Array(2 + fromBytes.length + tidBytes.length + chunk.length);
    payload[0] = fromBytes.length;
    payload[1] = tidBytes.length;
    payload.set(fromBytes, 2);
    payload.set(tidBytes, 2 + fromBytes.length);
    payload.set(chunk, 2 + fromBytes.length + tidBytes.length);
    this.ws.send(buildPublishPacket(topic, payload));
    return true;
  }

  sendInboxInvite(to: string, roomCode: string): boolean {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const topic = `${TOPIC_PREFIX}/inbox/${to}`;
    const payload = textEncoder.encode(
      JSON.stringify({
        kind: 'invite',
        from: this.clientId,
        name: this.deviceName,
        deviceType: this.deviceType,
        roomCode,
      }),
    );
    this.ws.send(buildPublishPacket(topic, payload));
    return true;
  }

  private connectNext(): void {
    if (this.destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = BROKERS[this.brokerIdx % BROKERS.length];
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, ['mqtt']);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.rxBuffer = new Uint8Array(0);

    ws.onopen = () => {
      const mqttId = `relay-${this.clientId}-${Math.random().toString(36).slice(2, 6)}`;
      ws.send(buildConnectPacket(mqttId, 30));
    };

    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const incoming = new Uint8Array(event.data);
      const merged = new Uint8Array(this.rxBuffer.length + incoming.length);
      merged.set(this.rxBuffer, 0);
      merged.set(incoming, this.rxBuffer.length);
      this.rxBuffer = merged;
      this.drainPackets();
    };

    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
      }
      const wasConnected = this.connected;
      this.connected = false;
      this.clearTimers();
      if (wasConnected) {
        this.callbacks.onStatusChange(false);
      }
      if (!this.destroyed) {
        this.brokerIdx = (this.brokerIdx + 1) % BROKERS.length;
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // Handled in onclose
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectNext();
    }, 2000);
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.presenceTimer !== null) {
      window.clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  private drainPackets(): void {
    let offset = 0;
    while (offset + 2 <= this.rxBuffer.length) {
      const header = this.rxBuffer[offset];
      let multiplier = 1;
      let remLen = 0;
      let idx = offset + 1;
      let encodedByte = 0;
      let incomplete = false;

      do {
        if (idx >= this.rxBuffer.length) {
          incomplete = true;
          break;
        }
        encodedByte = this.rxBuffer[idx++];
        remLen += (encodedByte & 127) * multiplier;
        multiplier *= 128;
      } while ((encodedByte & 128) !== 0);

      if (incomplete || idx + remLen > this.rxBuffer.length) {
        break;
      }

      const payloadStart = idx;
      const packetEnd = idx + remLen;
      this.handlePacket(header, this.rxBuffer.subarray(payloadStart, packetEnd));
      offset = packetEnd;
    }

    if (offset > 0) {
      this.rxBuffer = this.rxBuffer.slice(offset);
    }
  }

  private handlePacket(header: number, body: Uint8Array): void {
    const packetType = (header >> 4) & 0x0f;

    if (packetType === 2) {
      // CONNACK
      if (body.length >= 2 && body[1] === 0) {
        this.connected = true;
        this.callbacks.onStatusChange(true);
        this.subscribeCurrentRoom();
        this.publishPresence();

        this.clearTimers();
        this.pingTimer = window.setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(new Uint8Array([0xc0, 0x00]));
          }
        }, 20000);
        this.presenceTimer = window.setInterval(() => {
          this.publishPresence();
        }, PRESENCE_INTERVAL_MS);
      }
      return;
    }

    if (packetType === 3) {
      // PUBLISH
      if (body.length < 2) return;
      const topicLen = (body[0] << 8) | body[1];
      if (2 + topicLen > body.length) return;
      const topic = textDecoder.decode(body.subarray(2, 2 + topicLen));
      let pos = 2 + topicLen;
      const qos = (header >> 1) & 0x03;
      if (qos > 0) {
        pos += 2;
      }
      if (pos > body.length) return;
      const payload = body.subarray(pos);
      this.handlePublish(topic, payload);
    }
  }

  private subscribeCurrentRoom(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.roomCode) return;
    const id = this.packetIdSeq++;
    const topics = [
      `${TOPIC_PREFIX}/${this.roomCode}/presence`,
      `${TOPIC_PREFIX}/${this.roomCode}/to/${this.clientId}`,
      `${TOPIC_PREFIX}/${this.roomCode}/bin/${this.clientId}`,
      `${TOPIC_PREFIX}/inbox/${this.clientId}`,
    ];
    this.ws.send(buildSubscribePacket(id, topics));
  }

  private publishPresence(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.roomCode) return;
    const topic = `${TOPIC_PREFIX}/${this.roomCode}/presence`;
    const payload = textEncoder.encode(
      JSON.stringify({
        kind: 'hello',
        id: this.clientId,
        name: this.deviceName,
        deviceType: this.deviceType,
      }),
    );
    this.ws.send(buildPublishPacket(topic, payload));
  }

  private publishBye(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.roomCode) return;
    const topic = `${TOPIC_PREFIX}/${this.roomCode}/presence`;
    const payload = textEncoder.encode(
      JSON.stringify({
        kind: 'bye',
        id: this.clientId,
      }),
    );
    this.ws.send(buildPublishPacket(topic, payload));
  }

  private handlePublish(topic: string, payload: Uint8Array): void {
    const presenceTopic = `${TOPIC_PREFIX}/${this.roomCode}/presence`;
    const directTopic = `${TOPIC_PREFIX}/${this.roomCode}/to/${this.clientId}`;
    const binTopic = `${TOPIC_PREFIX}/${this.roomCode}/bin/${this.clientId}`;
    const inboxTopic = `${TOPIC_PREFIX}/inbox/${this.clientId}`;

    if (topic === inboxTopic) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(textDecoder.decode(payload)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.kind !== 'invite') return;
      const from = typeof msg.from === 'string' ? msg.from : '';
      const roomCode = typeof msg.roomCode === 'string' ? msg.roomCode : '';
      if (!from || from === this.clientId || !roomCode) return;
      const name = typeof msg.name === 'string' ? msg.name : 'Device';
      const deviceType: DeviceType =
        msg.deviceType === 'mobile' || msg.deviceType === 'tablet' ? msg.deviceType : 'desktop';
      this.callbacks.onInboxInvite({from, name, deviceType, roomCode});
      return;
    }

    if (topic === presenceTopic) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(textDecoder.decode(payload)) as Record<string, unknown>;
      } catch {
        return;
      }
      const id = typeof msg.id === 'string' ? msg.id : '';
      if (!id || id === this.clientId) return;

      if (msg.kind === 'bye') {
        if (this.peers.delete(id)) {
          this.emitPeers();
        }
        return;
      }

      if (msg.kind === 'hello') {
        const name = typeof msg.name === 'string' ? msg.name : 'Device';
        const deviceType: DeviceType =
          msg.deviceType === 'mobile' || msg.deviceType === 'tablet' ? msg.deviceType : 'desktop';
        const existing = this.peers.get(id);
        const changed = !existing || existing.name !== name || existing.deviceType !== deviceType;
        if (!existing) {
          // Immediately announce ourselves back so the newcomer discovers us instantly
          this.publishPresence();
        }
        this.peers.set(id, {id, name, deviceType, lastSeen: Date.now()});
        if (changed) {
          this.emitPeers();
        }
      }
      return;
    }

    if (topic === directTopic) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(textDecoder.decode(payload)) as Record<string, unknown>;
      } catch {
        return;
      }
      const from = typeof msg.from === 'string' ? msg.from : '';
      if (!from || from === this.clientId) return;
      this.callbacks.onDirectJson(from, msg);
      return;
    }

    if (topic === binTopic) {
      if (payload.length < 3) return;
      const fromLen = payload[0];
      const tidLen = payload[1];
      const headerLen = 2 + fromLen + tidLen;
      if (payload.length < headerLen) return;
      const from = textDecoder.decode(payload.subarray(2, 2 + fromLen));
      const tid = textDecoder.decode(payload.subarray(2 + fromLen, headerLen));
      const chunk = payload.slice(headerLen);
      this.callbacks.onDirectBinary(from, tid, chunk);
    }
  }

  private pruneExpiredPeers(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers.entries()) {
      if (now - peer.lastSeen > PEER_TTL_MS) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emitPeers();
    }
  }

  private emitPeers(): void {
    const list = Array.from(this.peers.values()).map(({id, name, deviceType}) => ({
      id,
      name,
      deviceType,
    }));
    this.callbacks.onPeersChange(list);
  }
}
