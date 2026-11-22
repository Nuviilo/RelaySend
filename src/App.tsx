import {useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent} from 'react';
import {
  ArrowUpDown,
  Bookmark,
  BookmarkCheck,
  Check,
  Copy,
  Download,
  Folder,
  Laptop,
  Moon,
  Pencil,
  QrCode as QrCodeIcon,
  RefreshCw,
  Smartphone,
  Sun,
  Tablet,
  Unlink,
  Upload,
  X,
} from 'lucide-react';
import {QrCode} from './components/QrCode';
import {detectDeviceInfo, formatBytes, formatSpeed, normalizeRoomCode} from './lib/format';
import {
  getCustomServerUrl,
  getHttpBaseUrl,
  isNativeShell,
  setCustomServerUrl,
} from './lib/serverConfig';
import {TransferEngine} from './lib/transferEngine';
import type {
  DeviceType,
  IncomingInvite,
  OutgoingFileInput,
  PeerInfo,
  RoomState,
  SavedDevice,
  TransferItem,
} from './types';

function DeviceIcon({type}: {type: DeviceType}) {
  if (type === 'mobile') {
    return <Smartphone className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />;
  }
  if (type === 'tablet') {
    return <Tablet className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />;
  }
  return <Laptop className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />;
}

function RelayMark() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="h-6 w-6 shrink-0"
    >
      <rect width="64" height="64" rx="16" fill="#2563EB" />
      <path
        d="M18 24H44M44 24L36 16M44 24L36 32"
        stroke="#FFFFFF"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M46 40H20M20 40L28 32M20 40L28 48"
        stroke="#FFFFFF"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getInitialRoomCode(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    return normalizeRoomCode(params.get('room') || '');
  } catch {
    return '';
  }
}

function getInitialDark(): boolean {
  try {
    return document.documentElement.classList.contains('dark');
  } catch {
    return false;
  }
}

function detectIsAndroid(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as unknown as {
    RelayAndroid?: unknown;
    Capacitor?: {getPlatform?: () => string};
  };
  if (win.RelayAndroid) return true;
  if (win.Capacitor?.getPlatform?.() === 'android') return true;
  return /Android/i.test(navigator.userAgent || '');
}

interface DropEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (cb: (file: File) => void, errCb?: (err: unknown) => void) => void;
  createReader?: () => {
    readEntries: (cb: (entries: DropEntryLike[]) => void, errCb?: (err: unknown) => void) => void;
  };
}

async function readEntryRecursively(entry: DropEntryLike, prefix = ''): Promise<OutgoingFileInput[]> {
  if (entry.isFile && typeof entry.file === 'function') {
    const getFile = entry.file.bind(entry);
    return new Promise((resolve) => {
      getFile(
        (file) => {
          const rel = prefix ? `${prefix}/${file.name}` : undefined;
          resolve([{file, relativePath: rel}]);
        },
        () => resolve([]),
      );
    });
  }

  if (entry.isDirectory && typeof entry.createReader === 'function') {
    const reader = entry.createReader();
    const childEntries: DropEntryLike[] = [];
    await new Promise<void>((resolve) => {
      const readBatch = () => {
        reader.readEntries(
          (batch) => {
            if (!batch || batch.length === 0) {
              resolve();
              return;
            }
            childEntries.push(...batch);
            readBatch();
          },
          () => resolve(),
        );
      };
      readBatch();
    });

    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    const nested: OutgoingFileInput[] = [];
    for (const child of childEntries) {
      const items = await readEntryRecursively(child, nextPrefix);
      nested.push(...items);
    }
    return nested;
  }

  return [];
}

async function extractDroppedFiles(dataTransfer: DataTransfer): Promise<OutgoingFileInput[]> {
  const items = dataTransfer.items;
  if (items && items.length > 0) {
    const entries: DropEntryLike[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as unknown as {webkitGetAsEntry?: () => DropEntryLike | null};
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      if (entry) {
        entries.push(entry);
      }
    }
    if (entries.length > 0) {
      const results: OutgoingFileInput[] = [];
      for (const entry of entries) {
        const extracted = await readEntryRecursively(entry);
        results.push(...extracted);
      }
      if (results.length > 0) {
        return results;
      }
    }
  }

  return Array.from(dataTransfer.files || []).map((file) => ({file}));
}

export default function App() {
  const initialDevice = useMemo(() => detectDeviceInfo(), []);
  const isAndroid = useMemo(() => detectIsAndroid(), []);
  const [mobileTab, setMobileTab] = useState<'devices' | 'files'>('devices');
  const [isDark, setIsDark] = useState<boolean>(getInitialDark);
  const [deviceName, setDeviceName] = useState<string>(() => {
    try {
      return localStorage.getItem('relay_device_name') || initialDevice.name;
    } catch {
      return initialDevice.name;
    }
  });
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(deviceName);

  const [roomState, setRoomState] = useState<RoomState>({
    connected: false,
    reconnecting: false,
    myId: null,
    roomCode: getInitialRoomCode(),
    peers: [],
  });
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [selectedPeerIds, setSelectedPeerIds] = useState<string[]>([]);

  const [joinInput, setJoinInput] = useState('');
  const [showQr, setShowQr] = useState(true);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [autoAccept, setAutoAccept] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [serverInput, setServerInput] = useState(() => getCustomServerUrl() || getHttpBaseUrl());
  const [activeServerUrl, setActiveServerUrl] = useState(() => getHttpBaseUrl());
  const [savedDevices, setSavedDevices] = useState<SavedDevice[]>(() => {
    try {
      const raw = localStorage.getItem('relay_saved_devices');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SavedDevice[]) : [];
    } catch {
      return [];
    }
  });
  const [pendingInvite, setPendingInvite] = useState<IncomingInvite | null>(null);

  const savedDevicesRef = useRef<SavedDevice[]>(savedDevices);
  savedDevicesRef.current = savedDevices;

  const nativeShell = useMemo(() => isNativeShell(), []);
  const engineRef = useRef<TransferEngine | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    const input = folderInputRef.current;
    if (input) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('relay_saved_devices', JSON.stringify(savedDevices));
    } catch {
      // Ignore storage errors
    }
  }, [savedDevices]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', isDark ? '#09090B' : '#FAFAFA');
    }
    try {
      localStorage.setItem('relay_theme', isDark ? 'dark' : 'light');
    } catch {
      // Ignore storage errors
    }
  }, [isDark]);

  useEffect(() => {
    const engine = new TransferEngine({
      name: deviceName,
      deviceType: initialDevice.deviceType,
      initialRoomCode: getInitialRoomCode(),
    });
    engineRef.current = engine;

    const unsubscribe = engine.subscribe((nextRoom, nextTransfers) => {
      setRoomState(nextRoom);
      setTransfers(nextTransfers);
    });

    const unsubscribeInvites = engine.subscribeInvites((invite) => {
      const isKnownSaved = savedDevicesRef.current.some((d) => d.id === invite.from);
      if (isKnownSaved) {
        setSavedDevices((prev) =>
          prev.map((d) =>
            d.id === invite.from
              ? {...d, name: invite.name, deviceType: invite.deviceType, lastRoomCode: invite.roomCode}
              : d,
          ),
        );
        engine.joinRoom(invite.roomCode);
        setNotice(`Connected to ${invite.name}`);
      } else {
        setPendingInvite(invite);
      }
    });

    engine.connect();

    return () => {
      unsubscribe();
      unsubscribeInvites();
      engine.destroy();
      engineRef.current = null;
    };
    // Intentionally initialize engine once on mount; renames use engine.renameDevice()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!roomState.roomCode || nativeShell) return;
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('room') !== roomState.roomCode) {
        url.searchParams.set('room', roomState.roomCode);
        window.history.replaceState(null, '', url.toString());
      }
    } catch {
      // Ignore history errors
    }
  }, [roomState.roomCode, nativeShell]);

  useEffect(() => {
    const activeIds = new Set(roomState.peers.map((p) => p.id));
    setSelectedPeerIds((prev) => prev.filter((id) => activeIds.has(id)));

    if (roomState.peers.length > 0 && roomState.roomCode) {
      setSavedDevices((prev) => {
        let changed = false;
        const next = prev.map((d) => {
          const match = roomState.peers.find((p) => p.id === d.id);
          if (match && (match.name !== d.name || d.lastRoomCode !== roomState.roomCode)) {
            changed = true;
            return {
              ...d,
              name: match.name,
              deviceType: match.deviceType,
              lastRoomCode: roomState.roomCode,
            };
          }
          return d;
        });
        return changed ? next : prev;
      });
    }
  }, [roomState.peers, roomState.roomCode]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const shareUrl = useMemo(() => {
    if (!roomState.roomCode) return '';
    return `${activeServerUrl}/?room=${roomState.roomCode}`;
  }, [roomState.roomCode, activeServerUrl]);

  const handleSaveName = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = nameDraft.trim().slice(0, 48);
    if (!trimmed) {
      setNameDraft(deviceName);
      setEditingName(false);
      return;
    }
    setDeviceName(trimmed);
    setEditingName(false);
    try {
      localStorage.setItem('relay_device_name', trimmed);
    } catch {
      // Ignore storage errors
    }
    engineRef.current?.renameDevice(trimmed);
  };

  const handleJoinSubmit = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeRoomCode(joinInput);
    if (normalized.length < 4) {
      setNotice('Enter a valid room code');
      return;
    }
    engineRef.current?.joinRoom(normalized);
    setJoinInput('');
  };

  const handleNewRoom = () => {
    engineRef.current?.createNewRoom();
  };

  const handleSaveServerUrl = (e: FormEvent) => {
    e.preventDefault();
    try {
      const normalized = setCustomServerUrl(serverInput);
      const nextBase = getHttpBaseUrl();
      new URL(nextBase);
      setActiveServerUrl(nextBase);
      setServerInput(normalized || nextBase);
      setShowServerConfig(false);
      engineRef.current?.reconnectToServer();
    } catch {
      setNotice('Enter a valid http:// or https:// server URL');
    }
  };

  const handleCopyCode = async () => {
    if (!roomState.roomCode) return;
    try {
      await navigator.clipboard.writeText(roomState.roomCode);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      setNotice('Could not copy code');
    }
  };

  const handleCopyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1800);
    } catch {
      setNotice('Could not copy link');
    }
  };

  const togglePeerSelection = (peer: PeerInfo) => {
    setSelectedPeerIds((prev) =>
      prev.includes(peer.id) ? prev.filter((id) => id !== peer.id) : [...prev, peer.id],
    );
  };

  const toggleSaveDevice = (peer: PeerInfo) => {
    const exists = savedDevices.some((d) => d.id === peer.id);
    if (exists) {
      setSavedDevices((prev) => prev.filter((d) => d.id !== peer.id));
    } else {
      const entry: SavedDevice = {
        id: peer.id,
        name: peer.name,
        deviceType: peer.deviceType,
        lastRoomCode: roomState.roomCode,
        savedAt: Date.now(),
      };
      setSavedDevices((prev) => [entry, ...prev.filter((d) => d.id !== peer.id)]);
    }
  };

  const handleDisconnectPeer = (peer: PeerInfo) => {
    engineRef.current?.disconnectPeer(peer.id);
  };

  const handleDisconnectAll = () => {
    engineRef.current?.disconnectAll();
  };

  const handleConnectSaved = (device: SavedDevice) => {
    const sent = engineRef.current?.inviteSavedDevice(device);
    if (sent) {
      setNotice(`Connecting to ${device.name}...`);
    } else {
      setNotice('Connecting to network, try again in a moment');
    }
  };

  const handleRemoveSaved = (deviceId: string) => {
    setSavedDevices((prev) => prev.filter((d) => d.id !== deviceId));
  };

  const handleAcceptInvite = () => {
    if (!pendingInvite) return;
    engineRef.current?.joinRoom(pendingInvite.roomCode);
    setPendingInvite(null);
  };

  const dispatchFiles = (fileList: FileList | File[] | OutgoingFileInput[]) => {
    const entries: Array<File | OutgoingFileInput> =
      fileList instanceof FileList ? Array.from(fileList) : fileList;
    if (entries.length === 0) return;

    if (roomState.peers.length === 0) {
      setNotice('Connect another device first to send files');
      return;
    }

    const targets = selectedPeerIds.length > 0 ? selectedPeerIds : undefined;
    void engineRef.current?.sendFiles(entries, targets);
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      dispatchFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleFolderInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      dispatchFiles(files);
      e.target.value = '';
    }
  };

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragging(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    void extractDroppedFiles(dt).then((files) => {
      if (files.length > 0) {
        dispatchFiles(files);
      }
    });
  };

  const handleToggleAutoAccept = () => {
    const next = !autoAccept;
    setAutoAccept(next);
    engineRef.current?.setAutoAccept(next);
  };

  const hasNativeDownloads = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const w = window as unknown as {
      RelayAndroid?: unknown;
      relayDesktop?: {startFile?: unknown};
    };
    return Boolean(w.RelayAndroid || w.relayDesktop?.startFile);
  }, []);

  const hasFinishedTransfers = transfers.some(
    (t) => t.status === 'completed' || t.status === 'cancelled' || t.status === 'error',
  );

  const saveableCompletedCount = transfers.filter(
    (t) => t.direction === 'receive' && t.status === 'completed' && Boolean(t.downloadUrl),
  ).length;

  const targetSummary =
    roomState.peers.length === 0
      ? 'No devices connected'
      : selectedPeerIds.length > 0
        ? `Sending to ${selectedPeerIds.length} selected`
        : roomState.peers.length === 1
          ? `Sending to ${roomState.peers[0].name}`
          : `Sending to all ${roomState.peers.length} devices`;

  const activeTransfersCount = transfers.filter(
    (t) => t.status === 'waiting' || t.status === 'transferring',
  ).length;

  return (
    <div className="min-h-screen bg-[#FAFAFA] pb-[env(safe-area-inset-bottom)] text-zinc-950 transition-colors dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white pt-[env(safe-area-inset-top)] dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-6 px-4 sm:px-6">
          <a
            href="./"
            className="flex items-center gap-2.5 text-lg font-bold tracking-tight text-zinc-950 dark:text-white whitespace-nowrap shrink-0"
          >
            <RelayMark />
            <span>Relay</span>
          </a>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setIsDark((prev) => !prev)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              title={isDark ? 'Light mode' : 'Dark mode'}
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            {editingName ? (
              <form onSubmit={handleSaveName} className="flex items-center gap-2">
                <input
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  maxLength={48}
                  autoFocus
                  aria-label="Device name"
                  className="h-9 w-36 sm:w-44 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-950 focus:border-blue-600 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-blue-500"
                />
                <button
                  type="submit"
                  className="h-9 rounded-lg bg-zinc-950 px-3 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200 whitespace-nowrap shrink-0"
                >
                  Save
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setNameDraft(deviceName);
                  setEditingName(true);
                }}
                className="flex min-h-[40px] items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white whitespace-nowrap shrink-0"
                title="Rename this device"
              >
                <span className="max-w-[140px] sm:max-w-[180px] truncate font-medium text-zinc-900 dark:text-zinc-100">
                  {deviceName}
                </span>
                <Pencil className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500" />
              </button>
            )}
          </div>
        </div>
      </header>

      <main
        className={`mx-auto max-w-5xl px-4 py-6 pb-24 sm:px-6 sm:py-8 ${
          isAndroid ? 'pb-24 sm:pb-24' : 'lg:pb-8'
        }`}
      >
        {notice && (
          <div className="mb-6 flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200"
              aria-label="Dismiss message"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {pendingInvite && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <span className="text-zinc-800 dark:text-zinc-200">
              <strong className="font-semibold">{pendingInvite.name}</strong> wants to connect
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleAcceptInvite}
                className="h-8 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0"
              >
                Connect
              </button>
              <button
                type="button"
                onClick={() => setPendingInvite(null)}
                className="h-8 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0"
              >
                Ignore
              </button>
            </div>
          </div>
        )}

        <div
          className={
            isAndroid
              ? 'mx-auto max-w-xl'
              : 'grid grid-cols-1 gap-8 lg:grid-cols-12 items-start'
          }
        >
          {/* Left column / Devices tab */}
          <section
            className={`rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900 ${
              isAndroid
                ? mobileTab === 'devices'
                  ? 'block'
                  : 'hidden'
                : `${mobileTab === 'devices' ? 'block' : 'hidden lg:block'} lg:col-span-5`
            }`}
          >
            <div className="flex items-center justify-between gap-4">
              <h1 className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">Room code</h1>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setShowQr((v) => !v)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
                >
                  <QrCodeIcon className="h-3.5 w-3.5" />
                  <span>{showQr ? 'Hide QR' : 'QR'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleNewRoom}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
                  title="Generate a new room code"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>New</span>
                </button>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={handleCopyCode}
                className="group flex items-center gap-2.5 text-left"
                title="Copy code"
              >
                <span className="font-mono text-2xl font-semibold tracking-[0.16em] text-zinc-950 tabular-nums dark:text-white">
                  {roomState.roomCode || '------'}
                </span>
                {copiedCode ? (
                  <Check className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                ) : (
                  <Copy className="h-4 w-4 text-zinc-300 transition-colors group-hover:text-zinc-600 dark:text-zinc-600 dark:group-hover:text-zinc-300" />
                )}
              </button>

              <button
                type="button"
                onClick={handleCopyLink}
                disabled={!shareUrl}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3.5 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0"
              >
                {copiedLink ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                    <span>Copy link</span>
                  </>
                )}
              </button>
            </div>

            {showQr && shareUrl && (
              <div className="mt-5 flex flex-col items-center border-t border-zinc-100 pt-5 dark:border-zinc-800">
                <QrCode value={shareUrl} size={156} />
                <p className="mt-2.5 text-xs text-zinc-500 dark:text-zinc-400">
                  Scan on any device to connect
                </p>
              </div>
            )}

            <form
              onSubmit={handleJoinSubmit}
              className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-800"
            >
              <label
                htmlFor="join-code"
                className="block text-sm font-semibold text-zinc-950 dark:text-zinc-100"
              >
                Join another device
              </label>
              <div className="mt-2.5 flex items-center gap-2">
                <input
                  id="join-code"
                  type="text"
                  value={joinInput}
                  onChange={(e) => setJoinInput(normalizeRoomCode(e.target.value))}
                  placeholder="Enter code"
                  maxLength={8}
                  className="h-11 sm:h-10 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 font-mono text-sm uppercase tracking-widest text-zinc-950 placeholder:font-sans placeholder:normal-case placeholder:tracking-normal placeholder:text-zinc-400 focus:border-blue-600 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-blue-500"
                />
                <button
                  type="submit"
                  className="h-11 sm:h-10 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0"
                >
                  Connect
                </button>
              </div>
            </form>

            <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-800">
              <div className="flex items-center justify-between gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-zinc-950 dark:text-zinc-100">
                    Connected devices
                  </h2>
                  <span className="font-mono text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                    {roomState.peers.length}
                  </span>
                </div>
                {roomState.peers.length > 0 && (
                  <button
                    type="button"
                    onClick={handleDisconnectAll}
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
                  >
                    <Unlink className="h-3 w-3" />
                    <span>Disconnect all</span>
                  </button>
                )}
              </div>

              {roomState.peers.length === 0 ? (
                <p className="mt-3 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {roomState.connected
                    ? 'Open the link or enter this code on another device anywhere to connect.'
                    : 'Connecting...'}
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
                  {roomState.peers.map((peer) => {
                    const selected = selectedPeerIds.includes(peer.id);
                    const isSaved = savedDevices.some((d) => d.id === peer.id);
                    return (
                      <li
                        key={peer.id}
                        className="flex items-center justify-between gap-2 py-2"
                      >
                        <button
                          type="button"
                          onClick={() => togglePeerSelection(peer)}
                          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 -ml-2 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/70"
                        >
                          <DeviceIcon type={peer.deviceType} />
                          <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            {peer.name}
                          </span>
                          {roomState.peers.length > 1 && (
                            <span
                              className={`ml-auto text-xs font-medium whitespace-nowrap shrink-0 ${
                                selected
                                  ? 'text-blue-600 dark:text-blue-400'
                                  : 'text-zinc-400 dark:text-zinc-500'
                              }`}
                            >
                              {selected ? 'Selected' : 'Select'}
                            </span>
                          )}
                        </button>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => toggleSaveDevice(peer)}
                            className={`inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                              isSaved
                                ? 'text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40'
                                : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
                            }`}
                            title={isSaved ? 'Remove from saved devices' : 'Save device'}
                            aria-label={isSaved ? 'Saved' : 'Save device'}
                          >
                            {isSaved ? (
                              <BookmarkCheck className="h-3.5 w-3.5" />
                            ) : (
                              <Bookmark className="h-3.5 w-3.5" />
                            )}
                            <span>{isSaved ? 'Saved' : 'Save'}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleDisconnectPeer(peer)}
                            className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-red-600 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-red-400 whitespace-nowrap shrink-0"
                            title="Disconnect device"
                            aria-label={`Disconnect ${peer.name}`}
                          >
                            <Unlink className="h-3.5 w-3.5" />
                            <span>Disconnect</span>
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {savedDevices.length > 0 && (
                <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-800">
                  <div className="flex items-center justify-between text-sm">
                    <h2 className="font-semibold text-zinc-950 dark:text-zinc-100">
                      Saved devices
                    </h2>
                    <span className="font-mono text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                      {savedDevices.length}
                    </span>
                  </div>

                  <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
                    {savedDevices.map((device) => {
                      const isOnlineHere = roomState.peers.some((p) => p.id === device.id);
                      return (
                        <li
                          key={device.id}
                          className="flex items-center justify-between gap-2 py-2.5"
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <DeviceIcon type={device.deviceType} />
                            <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                              {device.name}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {isOnlineHere ? (
                              <span className="px-2 text-xs font-medium text-blue-600 dark:text-blue-400 whitespace-nowrap shrink-0">
                                Connected
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleConnectSaved(device)}
                                className="inline-flex h-8 items-center rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0"
                              >
                                Connect
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleRemoveSaved(device.id)}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                              title="Remove saved device"
                              aria-label={`Remove ${device.name}`}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {nativeShell && (
                <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setShowServerConfig((v) => !v)}
                    className="text-xs text-zinc-400 transition-colors hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300"
                  >
                    {showServerConfig ? 'Hide server' : 'Server'}
                  </button>

                  {showServerConfig && (
                    <form onSubmit={handleSaveServerUrl} className="mt-2.5 flex items-center gap-2">
                      <input
                        type="url"
                        value={serverInput}
                        onChange={(e) => setServerInput(e.target.value)}
                        placeholder="https://..."
                        aria-label="Server URL"
                        className="h-10 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 text-xs text-zinc-950 focus:border-blue-600 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-blue-500"
                      />
                      <button
                        type="submit"
                        className="h-10 rounded-lg bg-zinc-950 px-3 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200 whitespace-nowrap shrink-0"
                      >
                        Apply
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Right column / Files tab */}
          <section
            className={`space-y-6 ${
              isAndroid
                ? mobileTab === 'files'
                  ? 'block'
                  : 'hidden'
                : `${mobileTab === 'files' ? 'block' : 'hidden lg:block'} lg:col-span-7`
            }`}
          >
            <div
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className={`rounded-xl border border-dashed p-10 text-center transition-colors ${
                isDragging
                  ? 'border-blue-600 bg-blue-50/50 dark:border-blue-500 dark:bg-blue-950/30'
                  : 'border-zinc-300 bg-white hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileInputChange}
                className="hidden"
              />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                onChange={handleFolderInputChange}
                className="hidden"
              />

              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                <Upload className="h-5 w-5" />
              </div>

              <h2 className="mt-4 text-base font-semibold text-zinc-950 dark:text-white">
                Drop files or folders to share
              </h2>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{targetSummary}</p>

              <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex h-11 sm:h-10 items-center justify-center gap-2 rounded-lg bg-zinc-950 px-5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200 whitespace-nowrap shrink-0"
                >
                  <Upload className="h-4 w-4" />
                  <span>Choose files</span>
                </button>
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  className="inline-flex h-11 sm:h-10 items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0"
                >
                  <Folder className="h-4 w-4 text-zinc-500 dark:text-zinc-400" />
                  <span>Choose folder</span>
                </button>
                {roomState.peers.length === 0 && (
                  <button
                    type="button"
                    onClick={() => setMobileTab('devices')}
                    className={`inline-flex h-11 sm:h-10 items-center justify-center rounded-lg border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0 ${
                      isAndroid ? '' : 'lg:hidden'
                    }`}
                  >
                    Connect a device
                  </button>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
                <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">Transfers</h2>

                <div className="flex items-center gap-3.5">
                  {saveableCompletedCount > 1 && (
                    <button
                      type="button"
                      onClick={() => void engineRef.current?.saveAllCompletedTransfers()}
                      className="inline-flex h-7 items-center gap-1.5 rounded-md bg-blue-600 px-2.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0"
                    >
                      <Download className="h-3 w-3" />
                      <span>Save all ({saveableCompletedCount})</span>
                    </button>
                  )}

                  {activeTransfersCount > 1 && (
                    <button
                      type="button"
                      onClick={() => engineRef.current?.cancelAllActiveTransfers()}
                      className="text-xs font-medium text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
                    >
                      Cancel all
                    </button>
                  )}

                  {!hasNativeDownloads && (
                    <button
                      type="button"
                      onClick={handleToggleAutoAccept}
                      role="switch"
                      aria-checked={autoAccept}
                      className="inline-flex items-center gap-2 text-xs font-medium text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
                    >
                      <span>Auto-save</span>
                      <span
                        className={`inline-flex h-4 w-7 items-center rounded-full p-0.5 transition-colors ${
                          autoAccept ? 'bg-blue-600' : 'bg-zinc-200 dark:bg-zinc-700'
                        }`}
                      >
                        <span
                          className={`h-3 w-3 rounded-full bg-white transition-transform ${
                            autoAccept ? 'translate-x-3' : 'translate-x-0'
                          }`}
                        />
                      </span>
                    </button>
                  )}

                  {hasFinishedTransfers && (
                    <button
                      type="button"
                      onClick={() => engineRef.current?.clearFinishedTransfers()}
                      className="text-xs font-medium text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {transfers.length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  Files you send or receive will appear here.
                </div>
              ) : (
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {transfers.map((item) => {
                    const pct =
                      item.size > 0
                        ? Math.min(100, Math.round((item.bytesTransferred / item.size) * 100))
                        : item.status === 'completed'
                          ? 100
                          : 0;

                    return (
                      <li key={item.id} className="px-5 py-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <p
                              className="truncate text-sm font-medium text-zinc-950 dark:text-zinc-100"
                              title={item.relativePath || item.name}
                            >
                              {item.relativePath || item.name}
                            </p>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                              <span>
                                {item.direction === 'send'
                                  ? `To ${item.peerName}`
                                  : `From ${item.peerName}`}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                {item.status === 'transferring'
                                  ? `${formatBytes(item.bytesTransferred)} / ${formatBytes(item.size)}`
                                  : formatBytes(item.size)}
                              </span>
                              {item.status === 'transferring' && item.speedBps > 0 && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono tabular-nums">
                                    {formatSpeed(item.speedBps)}
                                  </span>
                                </>
                              )}
                              {item.status === 'waiting' && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>Queued</span>
                                </>
                              )}
                              {item.status === 'completed' && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-zinc-700 dark:text-zinc-300">
                                    {item.savedToDownloads ? 'Saved to Downloads' : 'Done'}
                                  </span>
                                </>
                              )}
                              {item.status === 'cancelled' && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>Cancelled</span>
                                </>
                              )}
                              {item.status === 'error' && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-red-600 dark:text-red-400">
                                    {item.error || 'Failed'}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {item.status === 'completed' && item.downloadUrl && (
                              <a
                                href={item.downloadUrl}
                                download={item.name}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0"
                              >
                                <Download className="h-3.5 w-3.5" />
                                <span>Download</span>
                              </a>
                            )}

                            {(item.status === 'waiting' || item.status === 'transferring') ? (
                              <button
                                type="button"
                                onClick={() => engineRef.current?.cancelTransfer(item.id)}
                                className="inline-flex h-8 items-center rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-950 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white whitespace-nowrap shrink-0"
                              >
                                Cancel
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => engineRef.current?.removeTransfer(item.id)}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                                aria-label="Remove transfer"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        </div>

                        {(item.status === 'transferring' || item.status === 'completed') && (
                          <div className="mt-3 flex items-center gap-3">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                              <div
                                className={`h-full rounded-full transition-all duration-150 ${
                                  item.status === 'completed'
                                    ? 'bg-zinc-900 dark:bg-zinc-200'
                                    : 'bg-blue-600 dark:bg-blue-500'
                                }`}
                                style={{width: `${pct}%`}}
                              />
                            </div>
                            <span className="w-10 text-right font-mono text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                              {pct}%
                            </span>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        </div>
      </main>

      <nav
        aria-label="Primary views"
        className={`fixed bottom-0 left-0 right-0 z-40 border-t border-zinc-200 bg-white/95 backdrop-blur-md pb-[env(safe-area-inset-bottom)] dark:border-zinc-800 dark:bg-zinc-900/95 ${
          isAndroid ? 'block' : 'lg:hidden'
        }`}
      >
        <div className="mx-auto grid h-14 max-w-xl grid-cols-2" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === 'devices'}
            onClick={() => setMobileTab('devices')}
            className={`relative flex flex-col items-center justify-center gap-1 transition-colors whitespace-nowrap shrink-0 ${
              mobileTab === 'devices'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            {mobileTab === 'devices' && (
              <span
                aria-hidden="true"
                className="absolute top-0 h-0.5 w-10 rounded-full bg-blue-600 dark:bg-blue-400"
              />
            )}
            <Smartphone className="h-5 w-5" />
            <span className="text-[11px] font-medium leading-none tabular-nums">
              {roomState.peers.length > 0 ? `Devices (${roomState.peers.length})` : 'Devices'}
            </span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === 'files'}
            onClick={() => setMobileTab('files')}
            className={`relative flex flex-col items-center justify-center gap-1 transition-colors whitespace-nowrap shrink-0 ${
              mobileTab === 'files'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            {mobileTab === 'files' && (
              <span
                aria-hidden="true"
                className="absolute top-0 h-0.5 w-10 rounded-full bg-blue-600 dark:bg-blue-400"
              />
            )}
            <ArrowUpDown className="h-5 w-5" />
            <span className="text-[11px] font-medium leading-none tabular-nums">
              {activeTransfersCount > 0 ? `Files (${activeTransfersCount})` : 'Files'}
            </span>
          </button>
        </div>
      </nav>
    </div>
  );
}
