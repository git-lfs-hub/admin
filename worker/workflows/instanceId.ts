// Cloudflare Workflow instance ids must match `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` and be ≤100 chars —
// `/`, `.`, `:` (which our keys, e.g. `owner/repo.git`, carry) are all rejected, and local dev
// does NOT enforce this, so a bad id silently breaks `get`/`sendEvent` instead of throwing.
// Build every workflow id here so they're valid by construction and validated before use.
const VALID_INSTANCE_ID = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;
const MAX_INSTANCE_ID_LEN = 100;

// `<kind>-<escaped key>`. The escape is injective (distinct keys → distinct ids), so the id stays
// a deterministic, collision-free handle reconstructable from the key on approve/cancel.
export function workflowInstanceId(kind: string, key: string): string {
  const id = `${kind}-${escapeKey(key)}`;
  if (!VALID_INSTANCE_ID.test(id) || id.length > MAX_INSTANCE_ID_LEN) {
    throw new Error(`invalid workflow instance id (${id.length} chars): ${id}`);
  }
  return id;
}

// Pass through the id-safe set; map every other char (incl. `_` itself, the escape marker) to
// `_<2-hex>`. Keys are ASCII (GitHub owner/repo), so each code is exactly two hex digits, keeping
// the encoding unambiguous.
function escapeKey(key: string): string {
  return [...key]
    .map((c) => (/[a-zA-Z0-9-]/.test(c) ? c : `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`))
    .join('');
}
