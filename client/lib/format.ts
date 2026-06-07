import { filesize } from 'filesize';

export function formatSize(bytes: number): string {
  return filesize(bytes) as string;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Date only (no time) — compact for deadline columns; pair with `formatTime` on hover. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/** Coarse "time ago": seconds, then minutes, hours, days. */
export function formatRelative(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
