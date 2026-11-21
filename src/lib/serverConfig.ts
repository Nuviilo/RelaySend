const DEFAULT_REMOTE_SERVER_URL =
  'https://ais-pre-5timat5a7igmjxnk73xoqe-711147849365.asia-east1.run.app';
const STORAGE_KEY = 'relay_server_url';

export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  const proto = window.location.protocol;
  const ua = navigator.userAgent || '';
  const hasCapacitor = Boolean((window as unknown as {Capacitor?: unknown}).Capacitor);
  const hasDesktopBridge = Boolean((window as unknown as {relayDesktop?: unknown}).relayDesktop);
  return (
    proto === 'file:' ||
    proto === 'capacitor:' ||
    proto === 'app:' ||
    hasCapacitor ||
    hasDesktopBridge ||
    ua.includes('Electron')
  );
}

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function getCustomServerUrl(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setCustomServerUrl(url: string): string {
  const normalized = normalizeServerUrl(url);
  try {
    if (normalized) {
      localStorage.setItem(STORAGE_KEY, normalized);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
  return normalized;
}

export function getHttpBaseUrl(): string {
  const saved = getCustomServerUrl();
  if (saved) return saved;

  const envUrl =
    typeof import.meta !== 'undefined' && import.meta.env?.VITE_RELAY_SERVER_URL
      ? normalizeServerUrl(String(import.meta.env.VITE_RELAY_SERVER_URL))
      : '';
  if (envUrl) return envUrl;

  if (isNativeShell()) {
    return DEFAULT_REMOTE_SERVER_URL;
  }

  return window.location.origin;
}

export function getWsUrl(): string {
  const base = getHttpBaseUrl();
  const parsed = new URL(base);
  const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${parsed.host}/ws`;
}
