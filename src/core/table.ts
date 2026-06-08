/**
 * Render rows (the first row is typically a header) as a left-aligned, two-space-padded text table.
 * Columns are sized to the widest cell; ragged rows are padded with empty cells. Dependency-free.
 */
export function alignTable(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  if (rows.length === 0) return '';
  const cols = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((row) => (row[c] ?? '').length)));
  return rows.map((row) => widths.map((w, c) => (row[c] ?? '').padEnd(w)).join('  ').trimEnd()).join('\n');
}
