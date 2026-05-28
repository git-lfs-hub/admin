export function isoNow(): string {
  return isoStripMs(new Date())
}

export function isoAddDays(iso: string, days: number): string {
  const d = new Date(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return isoStripMs(d)
}

function isoStripMs(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
