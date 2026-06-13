export type GcConfig = CloudflareBindings['GC'];

// Every GC tunable has a safe default so a config that omits any key (or the whole GC var) can't
// crash a consumer — e.g. a missing `confirmDays` makes `isoAddDays` produce an Invalid Date.
const GC_DEFAULTS: GcConfig = {
  autoDays: { archive: 7, clear: 30 },
  confirmDays: 3,
  retentionDays: { live: 30, cold: 365 },
  coldStorage: '',
};

export function gcConfig(env: CloudflareBindings): GcConfig {
  return { ...GC_DEFAULTS, ...env.GC };
}
