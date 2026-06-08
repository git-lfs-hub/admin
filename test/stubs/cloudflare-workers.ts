// Stub for the node `unit` vitest project. Worker modules now value-import the DO classes
// (for the `Registry.global` / `Storage.byPrefix` accessors), which transitively pull in the
// `cloudflare:workers` base class — only the workers pool provides it. Unit specs never
// construct a DO (the accessors only call `env.<NS>.getByName(...)`), so a no-op base is enough.
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}

export const env = {};
