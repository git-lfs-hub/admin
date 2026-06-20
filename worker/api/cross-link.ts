/** Bucket flat rows into a key→values map — turns the SQL-joined active-link rows behind
 *  `/api/repos` and `/api/storage` into the per-repo / per-prefix arrays the listings return. */
export function groupBy<T, K, V>(rows: T[], keyOf: (r: T) => K, valOf: (r: T) => V): Map<K, V[]> {
  const grouped = new Map<K, V[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = grouped.get(key) ?? [];
    list.push(valOf(row));
    grouped.set(key, list);
  }
  return grouped;
}
