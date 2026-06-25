// `coldStorage` is a runtime capability flag (empty = off, else a backend key), but wrangler
// types it as the single literal the active env happens to render — too narrow for the ''
// default and cross-env values. Widen it back to string.
export type GcConfig = Omit<CloudflareBindings['GC'], 'coldStorage'> & {
  coldStorage: string;
};

// Every GC tunable has a safe default so a config that omits any key (or the whole GC var) can't
// crash a consumer — e.g. a missing `confirmDays` makes `isoAddDays` produce an Invalid Date.
const GC_DEFAULTS: GcConfig = {
  autoDays: { archive: 7, clear: 30 },
  confirmDays: 3,
  retentionDays: { live: 30, cold: 365 },
  coldStorage: '',
};

export function gcConfig(env: CloudflareBindings): GcConfig {
  // Deep-merge `retentionDays` so an env that omits a key (pre-Phase-2 vars) keeps its default
  // rather than losing it to the shallow spread.
  return {
    ...GC_DEFAULTS,
    ...env.GC,
    retentionDays: { ...GC_DEFAULTS.retentionDays, ...env.GC?.retentionDays },
  };
}
