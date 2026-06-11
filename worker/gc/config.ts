type GcConfig = CloudflareBindings['GC'];

// Every GC tunable has a safe default so a config that omits any key (or the whole GC var) can't
// crash a consumer — e.g. a missing `purgeConfirmDays` makes `isoAddDays` produce an Invalid Date.
const GC_DEFAULTS: GcConfig = {
  autoArchiveDays: 7,
  autoClearDays: 30,
  purgeConfirmDays: 3,
  liveStorageRetentionDays: 30,
  coldStorageRetentionDays: 365,
  coldStorage: '',
};

export function gcConfig(env: CloudflareBindings): GcConfig {
  return { ...GC_DEFAULTS, ...env.GC };
}
