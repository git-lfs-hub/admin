import { filesize } from 'filesize'

export function formatSize(bytes: number): string {
  return filesize(bytes) as string
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
