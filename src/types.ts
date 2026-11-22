export type DeviceType = 'desktop' | 'mobile' | 'tablet';

export interface PeerInfo {
  id: string;
  name: string;
  deviceType: DeviceType;
}

export interface SavedDevice {
  id: string;
  name: string;
  deviceType: DeviceType;
  lastRoomCode: string;
  savedAt: number;
}

export interface IncomingInvite {
  from: string;
  name: string;
  deviceType: DeviceType;
  roomCode: string;
}

export type TransferDirection = 'send' | 'receive';

export type TransferStatus =
  | 'waiting'
  | 'transferring'
  | 'completed'
  | 'cancelled'
  | 'error';

export type TransportMode = 'p2p' | 'relay';

export interface OutgoingFileInput {
  file: File;
  relativePath?: string;
}

export interface TransferItem {
  id: string;
  peerId: string;
  peerName: string;
  name: string;
  relativePath?: string;
  size: number;
  mimeType: string;
  direction: TransferDirection;
  status: TransferStatus;
  bytesTransferred: number;
  speedBps: number;
  transport?: TransportMode;
  downloadUrl?: string;
  savedToDownloads?: boolean;
  error?: string;
}

export interface RoomState {
  connected: boolean;
  reconnecting: boolean;
  myId: string | null;
  roomCode: string;
  peers: PeerInfo[];
}
