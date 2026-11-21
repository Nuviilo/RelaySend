import type {DeviceType, PeerInfo, RoomState, TransferItem, TransportMode} from '../types';
import {getWsUrl} from './serverConfig';

const CHUNK_SIZE = 48 * 1024; // 48 KB — safe for WebRTC SCTP and smooth for WS relay
const MAX_DC_BUFFERED = 1024 * 1024; // 1 MB
const RELAY_ACK_INTERVAL = 32; // Ack every 32 chunks (~1.5 MB)
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    {urls: 'stun:stun.l.google.com:19302'},
    {urls: 'stun:stun1.l.google.com:19302'},
  ],
};

interface FileSystemWritableLike {
  write: (data: Uint8Array<ArrayBuffer>) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
  }) => Promise<{
    createWritable: () => Promise<FileSystemWritableLike>;
  }>;
  RelayAndroid?: {
    startFile: (transferId: string, fileName: string, mimeType: string) => boolean;
    appendChunk: (transferId: string, base64Chunk: string) => boolean;
    finishFile: (transferId: string) => boolean;
    abortFile: (transferId: string) => void;
  };
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x4000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

interface OutgoingJob {
  id: string;
  peerId: string;
  file: File;
  cancelled: boolean;
  acceptResolver?: (accepted: boolean) => void;
  ackResolver?: () => void;
  doneResolver?: () => void;
}

interface IncomingJob {
  id: string;
  peerId: string;
  name: string;
  size: number;
  mimeType: string;
  accepted: boolean;
  cancelled: boolean;
  bytesReceived: number;
  chunksReceived: number;
  lastSpeedTime: number;
  lastSpeedBytes: number;
  transport: TransportMode;
  writable: FileSystemWritableLike | null;
  androidSink: boolean;
  memoryChunks: Uint8Array<ArrayBuffer>[];
  writeChain: Promise<void>;
  finalized: boolean;
}

interface PeerConnectionEntry {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  pendingIce: RTCIceCandidateInit[];
  remoteDescSet: boolean;
}

type StateListener = (room: RoomState, transfers: TransferItem[]) => void;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class TransferEngine {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private destroyed = false;

  private clientId: string;
  private deviceName: string;
  private deviceType: DeviceType;
  private requestedRoomCode: string;
  private autoAccept = false;

  private roomState: RoomState = {
    connected: false,
    reconnecting: false,
    myId: null,
    roomCode: '',
    peers: [],
  };

  private transfers = new Map<string, TransferItem>();
  private transferOrder: string[] = [];
  private outgoingJobs = new Map<string, OutgoingJob>();
  private incomingJobs = new Map<string, IncomingJob>();
  private rtcPeers = new Map<string, PeerConnectionEntry>();
  private listeners = new Set<StateListener>();

  constructor(options: {
    name: string;
    deviceType: DeviceType;
    initialRoomCode?: string;
  }) {
    this.clientId = this.loadOrCreateClientId();
    this.deviceName = options.name;
    this.deviceType = options.deviceType;
    this.requestedRoomCode = options.initialRoomCode || '';
  }

  private loadOrCreateClientId(): string {
    try {
      const existing = sessionStorage.getItem('relay_client_id');
      if (existing) return existing;
      const created = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      sessionStorage.setItem('relay_client_id', created);
      return created;
    } catch {
      return Math.random().toString(36).slice(2, 14);
    }
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getRoomSnapshot(), this.getTransfersSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const room = this.getRoomSnapshot();
    const list = this.getTransfersSnapshot();
    for (const listener of this.listeners) {
      listener(room, list);
    }
  }

  private getRoomSnapshot(): RoomState {
    return {
      ...this.roomState,
      peers: [...this.roomState.peers],
    };
  }

  private getTransfersSnapshot(): TransferItem[] {
    return this.transferOrder
      .map((id) => this.transfers.get(id))
      .filter((item): item is TransferItem => Boolean(item))
      .map((item) => ({...item}));
  }

  setAutoAccept(enabled: boolean): void {
    this.autoAccept = enabled;
  }

  connect(): void {
    if (this.destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = getWsUrl();
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.roomState.connected = true;
      this.roomState.reconnecting = false;
      this.sendJson({
        type: 'join',
        roomCode: this.requestedRoomCode || this.roomState.roomCode || undefined,
        name: this.deviceName,
        deviceType: this.deviceType,
        clientId: this.clientId,
      });
      this.emit();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this.handleTextMessage(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        this.handleRelayBinaryFrame(event.data);
      }
    };

    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
      }
      this.roomState.connected = false;
      this.roomState.reconnecting = !this.destroyed;
      this.failActiveTransfers('Connection lost');
      this.closeAllRtc();
      this.emit();

      if (!this.destroyed) {
        if (this.reconnectTimer !== null) {
          window.clearTimeout(this.reconnectTimer);
        }
        this.reconnectTimer = window.setTimeout(() => {
          this.connect();
        }, 1500);
      }
    };

    ws.onerror = () => {
      // onclose handles cleanup and reconnect
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeAllRtc();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const item of this.transfers.values()) {
      if (item.downloadUrl) {
        URL.revokeObjectURL(item.downloadUrl);
      }
    }
    this.listeners.clear();
  }

  reconnectToServer(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeAllRtc();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connect();
  }

  joinRoom(code: string): void {
    this.requestedRoomCode = code;
    this.closeAllRtc();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendJson({
        type: 'join',
        roomCode: code || undefined,
        name: this.deviceName,
        deviceType: this.deviceType,
        clientId: this.clientId,
      });
    } else {
      this.connect();
    }
  }

  createNewRoom(): void {
    this.requestedRoomCode = '';
    this.roomState.roomCode = '';
    this.closeAllRtc();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendJson({
        type: 'join',
        name: this.deviceName,
        deviceType: this.deviceType,
        clientId: this.clientId,
      });
    } else {
      this.connect();
    }
  }

  renameDevice(newName: string): void {
    const trimmed = newName.trim().slice(0, 48);
    if (!trimmed) return;
    this.deviceName = trimmed;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendJson({type: 'rename', name: trimmed});
    }
  }

  private sendJson(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private sendSignal(to: string, payload: Record<string, unknown>): void {
    this.sendJson({type: 'signal', to, payload});
  }

  private handleTextMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = msg.type;
    if (type === 'joined') {
      this.roomState.myId = String(msg.clientId || this.clientId);
      this.roomState.roomCode = String(msg.roomCode || '');
      this.requestedRoomCode = this.roomState.roomCode;
      const peers = Array.isArray(msg.peers) ? (msg.peers as PeerInfo[]) : [];
      this.syncPeers(peers);
      this.emit();
      return;
    }

    if (type === 'room:peers') {
      const peers = Array.isArray(msg.peers) ? (msg.peers as PeerInfo[]) : [];
      this.syncPeers(peers);
      this.emit();
      return;
    }

    const from = typeof msg.from === 'string' ? msg.from : '';
    if (!from) return;

    if (type === 'rtc:offer') {
      void this.handleRtcOffer(from, msg.payload as RTCSessionDescriptionInit);
      return;
    }
    if (type === 'rtc:answer') {
      void this.handleRtcAnswer(from, msg.payload as RTCSessionDescriptionInit);
      return;
    }
    if (type === 'rtc:ice') {
      void this.handleRtcIce(from, msg.payload as RTCIceCandidateInit);
      return;
    }
    if (type === 'signal') {
      this.handlePeerSignal(from, (msg.payload || {}) as Record<string, unknown>);
    }
  }

  private syncPeers(allPeers: PeerInfo[]): void {
    const myId = this.roomState.myId;
    const otherPeers = allPeers.filter((p) => p.id !== myId);
    this.roomState.peers = otherPeers;

    const activeIds = new Set(otherPeers.map((p) => p.id));

    for (const [peerId, entry] of this.rtcPeers.entries()) {
      if (!activeIds.has(peerId)) {
        entry.dc?.close();
        entry.pc.close();
        this.rtcPeers.delete(peerId);
      }
    }

    // Mark active transfers with departed peers as error
    for (const [id, item] of this.transfers.entries()) {
      if (
        !activeIds.has(item.peerId) &&
        (item.status === 'waiting' || item.status === 'transferring')
      ) {
        item.status = 'error';
        item.error = 'Device disconnected';
        const outJob = this.outgoingJobs.get(id);
        if (outJob) {
          outJob.cancelled = true;
          outJob.acceptResolver?.(false);
          outJob.ackResolver?.();
          outJob.doneResolver?.();
        }
        const inJob = this.incomingJobs.get(id);
        if (inJob) {
          inJob.cancelled = true;
          void inJob.writable?.abort?.().catch(() => {});
        }
      }
    }

    // Initiate WebRTC connections deterministically
    if (myId) {
      for (const peer of otherPeers) {
        if (!this.rtcPeers.has(peer.id) && myId < peer.id) {
          void this.initiateRtc(peer.id);
        }
      }
    }
  }

  private createPeerEntry(peerId: string): PeerConnectionEntry {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const entry: PeerConnectionEntry = {
      pc,
      dc: null,
      pendingIce: [],
      remoteDescSet: false,
    };
    this.rtcPeers.set(peerId, entry);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendJson({
          type: 'rtc:ice',
          to: peerId,
          payload: event.candidate.toJSON(),
        });
      }
    };

    pc.ondatachannel = (event) => {
      this.setupDataChannel(peerId, entry, event.channel);
    };

    return entry;
  }

  private setupDataChannel(
    peerId: string,
    entry: PeerConnectionEntry,
    dc: RTCDataChannel,
  ): void {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    entry.dc = dc;

    dc.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleP2PBinaryFrame(peerId, event.data);
      }
    };
  }

  private async initiateRtc(peerId: string): Promise<void> {
    try {
      const entry = this.createPeerEntry(peerId);
      const dc = entry.pc.createDataChannel('relay', {ordered: true});
      this.setupDataChannel(peerId, entry, dc);

      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.sendJson({
        type: 'rtc:offer',
        to: peerId,
        payload: entry.pc.localDescription,
      });
    } catch {
      // Relay fallback remains available automatically
    }
  }

  private async handleRtcOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    try {
      let entry = this.rtcPeers.get(peerId);
      if (entry) {
        entry.dc?.close();
        entry.pc.close();
        this.rtcPeers.delete(peerId);
      }
      entry = this.createPeerEntry(peerId);
      await entry.pc.setRemoteDescription(offer);
      entry.remoteDescSet = true;
      for (const ice of entry.pendingIce) {
        await entry.pc.addIceCandidate(ice).catch(() => {});
      }
      entry.pendingIce = [];

      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      this.sendJson({
        type: 'rtc:answer',
        to: peerId,
        payload: entry.pc.localDescription,
      });
    } catch {
      // Relay fallback remains available
    }
  }

  private async handleRtcAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const entry = this.rtcPeers.get(peerId);
    if (!entry) return;
    try {
      await entry.pc.setRemoteDescription(answer);
      entry.remoteDescSet = true;
      for (const ice of entry.pendingIce) {
        await entry.pc.addIceCandidate(ice).catch(() => {});
      }
      entry.pendingIce = [];
    } catch {
      // Ignore
    }
  }

  private async handleRtcIce(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const entry = this.rtcPeers.get(peerId);
    if (!entry) return;
    if (!entry.remoteDescSet) {
      entry.pendingIce.push(candidate);
      return;
    }
    await entry.pc.addIceCandidate(candidate).catch(() => {});
  }

  private closeAllRtc(): void {
    for (const entry of this.rtcPeers.values()) {
      entry.dc?.close();
      entry.pc.close();
    }
    this.rtcPeers.clear();
  }

  async sendFiles(files: File[], targetPeerIds?: string[]): Promise<void> {
    const targets =
      targetPeerIds && targetPeerIds.length > 0
        ? this.roomState.peers.filter((p) => targetPeerIds.includes(p.id))
        : this.roomState.peers;

    if (targets.length === 0 || files.length === 0) return;

    for (const peer of targets) {
      for (const file of files) {
        const id =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

        const item: TransferItem = {
          id,
          peerId: peer.id,
          peerName: peer.name,
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          direction: 'send',
          status: 'waiting',
          bytesTransferred: 0,
          speedBps: 0,
        };
        this.transfers.set(id, item);
        this.transferOrder.unshift(id);

        const job: OutgoingJob = {
          id,
          peerId: peer.id,
          file,
          cancelled: false,
        };
        this.outgoingJobs.set(id, job);
        this.emit();

        void this.runOutgoingJob(job);
      }
    }
  }

  private async runOutgoingJob(job: OutgoingJob): Promise<void> {
    const item = this.transfers.get(job.id);
    if (!item) return;

    this.sendSignal(job.peerId, {
      kind: 'transfer:offer',
      transferId: job.id,
      name: job.file.name,
      size: job.file.size,
      mimeType: job.file.type || 'application/octet-stream',
    });

    const accepted = await new Promise<boolean>((resolve) => {
      job.acceptResolver = resolve;
    });

    if (!accepted || job.cancelled) {
      if (item.status === 'waiting') {
        item.status = 'cancelled';
        this.emit();
      }
      this.outgoingJobs.delete(job.id);
      return;
    }

    const dc = this.rtcPeers.get(job.peerId)?.dc;
    const useP2P = Boolean(dc && dc.readyState === 'open');
    const transport: TransportMode = useP2P ? 'p2p' : 'relay';

    item.status = 'transferring';
    item.transport = transport;
    this.emit();

    const transferIdBytes = textEncoder.encode(job.id);
    const peerIdBytes = textEncoder.encode(job.peerId);

    let offset = 0;
    let chunksSinceAck = 0;
    let lastSpeedTime = performance.now();
    let lastSpeedBytes = 0;

    try {
      while (offset < job.file.size) {
        if (job.cancelled) {
          item.status = 'cancelled';
          this.emit();
          this.outgoingJobs.delete(job.id);
          return;
        }

        const end = Math.min(offset + CHUNK_SIZE, job.file.size);
        const sliceBuffer = await job.file.slice(offset, end).arrayBuffer();
        const chunk = new Uint8Array(sliceBuffer);

        if (transport === 'p2p' && dc && dc.readyState === 'open') {
          if (dc.bufferedAmount > MAX_DC_BUFFERED) {
            await this.waitForDcLowBuffer(dc);
          }
          const frame = new Uint8Array(2 + transferIdBytes.length + chunk.length);
          frame[0] = 1;
          frame[1] = transferIdBytes.length;
          frame.set(transferIdBytes, 2);
          frame.set(chunk, 2 + transferIdBytes.length);
          dc.send(frame);
        } else {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('Connection closed');
          }
          while (this.ws.bufferedAmount > MAX_DC_BUFFERED) {
            await new Promise((r) => window.setTimeout(r, 20));
          }
          const frame = new Uint8Array(3 + peerIdBytes.length + transferIdBytes.length + chunk.length);
          frame[0] = 1;
          frame[1] = peerIdBytes.length;
          frame[2] = transferIdBytes.length;
          frame.set(peerIdBytes, 3);
          frame.set(transferIdBytes, 3 + peerIdBytes.length);
          frame.set(chunk, 3 + peerIdBytes.length + transferIdBytes.length);
          this.ws.send(frame);

          chunksSinceAck++;
          if (chunksSinceAck >= RELAY_ACK_INTERVAL && end < job.file.size) {
            chunksSinceAck = 0;
            await new Promise<void>((resolve) => {
              const timeout = window.setTimeout(resolve, 4000);
              job.ackResolver = () => {
                window.clearTimeout(timeout);
                resolve();
              };
            });
          }
        }

        offset = end;
        item.bytesTransferred = offset;

        const now = performance.now();
        const elapsed = now - lastSpeedTime;
        if (elapsed >= 250 || offset >= job.file.size) {
          const deltaBytes = offset - lastSpeedBytes;
          item.speedBps = elapsed > 0 ? (deltaBytes / elapsed) * 1000 : item.speedBps;
          lastSpeedTime = now;
          lastSpeedBytes = offset;
          this.emit();
        }
      }

      this.sendSignal(job.peerId, {
        kind: 'transfer:complete',
        transferId: job.id,
      });

      // Wait briefly for receiver confirmation (done) so UI reflects actual completion
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 10000);
        job.doneResolver = () => {
          window.clearTimeout(timeout);
          resolve();
        };
      });

      const latestItem = this.transfers.get(job.id);
      if (latestItem && !job.cancelled && latestItem.status === 'transferring') {
        latestItem.status = 'completed';
        latestItem.bytesTransferred = job.file.size;
        latestItem.speedBps = 0;
        this.emit();
      }
    } catch (err) {
      item.status = 'error';
      item.error = err instanceof Error ? err.message : 'Transfer failed';
      this.emit();
    } finally {
      this.outgoingJobs.delete(job.id);
    }
  }

  private waitForDcLowBuffer(dc: RTCDataChannel): Promise<void> {
    return new Promise((resolve) => {
      if (dc.bufferedAmount <= dc.bufferedAmountLowThreshold || dc.readyState !== 'open') {
        resolve();
        return;
      }
      const timer = window.setTimeout(() => {
        dc.removeEventListener('bufferedamountlow', onLow);
        resolve();
      }, 200);
      const onLow = () => {
        window.clearTimeout(timer);
        dc.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      dc.addEventListener('bufferedamountlow', onLow);
    });
  }

  async acceptIncomingTransfer(transferId: string, usePicker = true): Promise<void> {
    const job = this.incomingJobs.get(transferId);
    const item = this.transfers.get(transferId);
    if (!job || !item || job.accepted || job.cancelled) return;

    const bridgeWin = window as SaveFilePickerWindow;
    let writable: FileSystemWritableLike | null = null;
    let androidSink = false;

    if (bridgeWin.RelayAndroid) {
      try {
        androidSink = bridgeWin.RelayAndroid.startFile(job.id, job.name, job.mimeType);
      } catch {
        androidSink = false;
      }
    }

    if (!androidSink && usePicker && typeof bridgeWin.showSaveFilePicker === 'function') {
      try {
        const handle = await bridgeWin.showSaveFilePicker({
          suggestedName: job.name,
        });
        writable = await handle.createWritable();
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        // Fall back cleanly to Blob streaming if blocked (e.g. iframe / unsupported)
        writable = null;
      }
    }

    job.writable = writable;
    job.androidSink = androidSink;
    job.accepted = true;
    job.lastSpeedTime = performance.now();
    item.status = 'transferring';
    this.emit();

    this.sendSignal(job.peerId, {
      kind: 'transfer:accept',
      transferId: job.id,
    });

    if (job.size === 0) {
      await this.finalizeIncomingJob(job);
    }
  }

  cancelTransfer(transferId: string): void {
    const item = this.transfers.get(transferId);
    if (!item) return;

    const outJob = this.outgoingJobs.get(transferId);
    if (outJob) {
      outJob.cancelled = true;
      outJob.acceptResolver?.(false);
      outJob.ackResolver?.();
      outJob.doneResolver?.();
      this.sendSignal(item.peerId, {kind: 'transfer:cancel', transferId});
    }

    const inJob = this.incomingJobs.get(transferId);
    if (inJob) {
      inJob.cancelled = true;
      void inJob.writable?.abort?.().catch(() => {});
      if (inJob.androidSink) {
        (window as SaveFilePickerWindow).RelayAndroid?.abortFile(inJob.id);
      }
      inJob.memoryChunks = [];
      this.incomingJobs.delete(transferId);
      this.sendSignal(item.peerId, {kind: 'transfer:cancel', transferId});
    }

    item.status = 'cancelled';
    item.speedBps = 0;
    this.emit();
  }

  removeTransfer(transferId: string): void {
    const item = this.transfers.get(transferId);
    if (item?.downloadUrl) {
      URL.revokeObjectURL(item.downloadUrl);
    }
    this.transfers.delete(transferId);
    this.transferOrder = this.transferOrder.filter((id) => id !== transferId);
    this.emit();
  }

  clearFinishedTransfers(): void {
    for (const id of [...this.transferOrder]) {
      const item = this.transfers.get(id);
      if (
        item &&
        (item.status === 'completed' || item.status === 'cancelled' || item.status === 'error')
      ) {
        if (item.downloadUrl) {
          URL.revokeObjectURL(item.downloadUrl);
        }
        this.transfers.delete(id);
        this.transferOrder = this.transferOrder.filter((x) => x !== id);
      }
    }
    this.emit();
  }

  private handlePeerSignal(from: string, payload: Record<string, unknown>): void {
    const kind = typeof payload.kind === 'string' ? payload.kind : '';
    const transferId = typeof payload.transferId === 'string' ? payload.transferId : '';
    if (!kind || !transferId) return;

    if (kind === 'transfer:offer') {
      const name = typeof payload.name === 'string' ? payload.name : 'file';
      const size = typeof payload.size === 'number' ? payload.size : 0;
      const mimeType =
        typeof payload.mimeType === 'string' ? payload.mimeType : 'application/octet-stream';
      const peerName = this.roomState.peers.find((p) => p.id === from)?.name || 'Device';

      const item: TransferItem = {
        id: transferId,
        peerId: from,
        peerName,
        name,
        size,
        mimeType,
        direction: 'receive',
        status: 'waiting',
        bytesTransferred: 0,
        speedBps: 0,
      };
      this.transfers.set(transferId, item);
      this.transferOrder.unshift(transferId);

      const inJob: IncomingJob = {
        id: transferId,
        peerId: from,
        name,
        size,
        mimeType,
        accepted: false,
        cancelled: false,
        bytesReceived: 0,
        chunksReceived: 0,
        lastSpeedTime: performance.now(),
        lastSpeedBytes: 0,
        transport: 'relay',
        writable: null,
        androidSink: false,
        memoryChunks: [],
        writeChain: Promise.resolve(),
        finalized: false,
      };
      this.incomingJobs.set(transferId, inJob);
      this.emit();

      if (this.autoAccept) {
        void this.acceptIncomingTransfer(transferId, false);
      }
      return;
    }

    if (kind === 'transfer:accept') {
      const outJob = this.outgoingJobs.get(transferId);
      if (outJob) {
        outJob.acceptResolver?.(true);
      }
      return;
    }

    if (kind === 'transfer:ack') {
      const outJob = this.outgoingJobs.get(transferId);
      if (outJob) {
        outJob.ackResolver?.();
        outJob.ackResolver = undefined;
      }
      return;
    }

    if (kind === 'transfer:complete') {
      const inJob = this.incomingJobs.get(transferId);
      if (inJob && !inJob.cancelled && inJob.bytesReceived >= inJob.size) {
        void this.finalizeIncomingJob(inJob);
      }
      return;
    }

    if (kind === 'transfer:done') {
      const outJob = this.outgoingJobs.get(transferId);
      if (outJob) {
        outJob.doneResolver?.();
      }
      return;
    }

    if (kind === 'transfer:cancel') {
      const outJob = this.outgoingJobs.get(transferId);
      if (outJob) {
        outJob.cancelled = true;
        outJob.acceptResolver?.(false);
        outJob.ackResolver?.();
        outJob.doneResolver?.();
      }
      const inJob = this.incomingJobs.get(transferId);
      if (inJob) {
        inJob.cancelled = true;
        void inJob.writable?.abort?.().catch(() => {});
        if (inJob.androidSink) {
          (window as SaveFilePickerWindow).RelayAndroid?.abortFile(inJob.id);
        }
        inJob.memoryChunks = [];
        this.incomingJobs.delete(transferId);
      }
      const item = this.transfers.get(transferId);
      if (item && item.status !== 'completed') {
        item.status = 'cancelled';
        item.speedBps = 0;
        this.emit();
      }
    }
  }

  private handleP2PBinaryFrame(_peerId: string, buffer: ArrayBuffer): void {
    const view = new Uint8Array(buffer);
    if (view.length < 2 || view[0] !== 1) return;
    const transferIdLen = view[1];
    if (view.length < 2 + transferIdLen) return;
    const transferId = textDecoder.decode(view.subarray(2, 2 + transferIdLen));
    const chunk = view.slice(2 + transferIdLen);
    this.appendIncomingChunk(transferId, chunk, 'p2p');
  }

  private handleRelayBinaryFrame(buffer: ArrayBuffer): void {
    const view = new Uint8Array(buffer);
    if (view.length < 4 || view[0] !== 1) return;
    const senderIdLen = view[1];
    const transferIdLen = view[2];
    const headerLen = 3 + senderIdLen + transferIdLen;
    if (view.length < headerLen) return;
    const transferId = textDecoder.decode(
      view.subarray(3 + senderIdLen, 3 + senderIdLen + transferIdLen),
    );
    const chunk = view.slice(headerLen);
    this.appendIncomingChunk(transferId, chunk, 'relay');
  }

  private appendIncomingChunk(
    transferId: string,
    chunk: Uint8Array<ArrayBuffer>,
    transport: TransportMode,
  ): void {
    const job = this.incomingJobs.get(transferId);
    const item = this.transfers.get(transferId);
    if (!job || !item || job.cancelled) return;

    job.transport = transport;
    item.transport = transport;
    job.bytesReceived += chunk.length;
    job.chunksReceived += 1;

    if (job.androidSink) {
      const bridge = (window as SaveFilePickerWindow).RelayAndroid;
      job.writeChain = job.writeChain.then(() => {
        if (!bridge?.appendChunk(job.id, uint8ToBase64(chunk))) {
          throw new Error('Failed writing to Downloads');
        }
      });
    } else if (job.writable) {
      const writable = job.writable;
      job.writeChain = job.writeChain.then(() => writable.write(chunk));
    } else {
      job.memoryChunks.push(chunk);
    }

    if (transport === 'relay' && job.chunksReceived % RELAY_ACK_INTERVAL === 0) {
      this.sendSignal(job.peerId, {
        kind: 'transfer:ack',
        transferId: job.id,
      });
    }

    item.bytesTransferred = Math.min(job.bytesReceived, job.size);
    const now = performance.now();
    const elapsed = now - job.lastSpeedTime;
    if (elapsed >= 250 || job.bytesReceived >= job.size) {
      const delta = job.bytesReceived - job.lastSpeedBytes;
      item.speedBps = elapsed > 0 ? (delta / elapsed) * 1000 : item.speedBps;
      job.lastSpeedTime = now;
      job.lastSpeedBytes = job.bytesReceived;
      this.emit();
    }

    if (job.bytesReceived >= job.size) {
      void this.finalizeIncomingJob(job);
    }
  }

  private async finalizeIncomingJob(job: IncomingJob): Promise<void> {
    if (job.finalized || job.cancelled) return;
    job.finalized = true;

    const item = this.transfers.get(job.id);
    if (!item) return;

    try {
      await job.writeChain;
      if (job.androidSink) {
        const ok = (window as SaveFilePickerWindow).RelayAndroid?.finishFile(job.id);
        if (!ok) {
          throw new Error('Could not finalize file in Downloads');
        }
        item.savedToDownloads = true;
      } else if (job.writable) {
        await job.writable.close();
        job.writable = null;
      } else {
        const blob = new Blob(job.memoryChunks, {type: job.mimeType});
        job.memoryChunks = [];
        const url = URL.createObjectURL(blob);
        item.downloadUrl = url;
        this.triggerBrowserDownload(url, job.name);
      }

      item.status = 'completed';
      item.bytesTransferred = job.size;
      item.speedBps = 0;
      this.sendSignal(job.peerId, {kind: 'transfer:done', transferId: job.id});
      this.emit();
    } catch (err) {
      item.status = 'error';
      item.error = err instanceof Error ? err.message : 'Save failed';
      this.emit();
    } finally {
      this.incomingJobs.delete(job.id);
    }
  }

  private triggerBrowserDownload(url: string, filename: string): void {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    window.setTimeout(() => {
      document.body.removeChild(a);
    }, 100);
  }

  private failActiveTransfers(reason: string): void {
    for (const [id, item] of this.transfers.entries()) {
      if (item.status === 'transferring' || item.status === 'waiting') {
        item.status = 'error';
        item.error = reason;
        const outJob = this.outgoingJobs.get(id);
        if (outJob) {
          outJob.cancelled = true;
          outJob.acceptResolver?.(false);
          outJob.ackResolver?.();
          outJob.doneResolver?.();
        }
        const inJob = this.incomingJobs.get(id);
        if (inJob) {
          inJob.cancelled = true;
          void inJob.writable?.abort?.().catch(() => {});
          if (inJob.androidSink) {
            (window as SaveFilePickerWindow).RelayAndroid?.abortFile(inJob.id);
          }
        }
      }
    }
  }
}
