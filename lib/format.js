// Render result rows as a markdown table, CSV, or JSON.
function cell(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

export function toMarkdown({ rows, columns, totalResults }) {
  if (!rows.length) return `_0 rows._`;
  const header = `| ${columns.join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows
    .map((r) => `| ${columns.map((c) => cell(r[c]).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)
    .join('\n');
  const note = totalResults > rows.length ? `\n\n_Showing ${rows.length} of ${totalResults} rows._` : '';
  return `${header}\n${sep}\n${body}${note}`;
}

export function toCsv({ rows, columns }) {
  const esc = (v) => {
    const s = cell(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

export function toJson(result) {
  return JSON.stringify(result.rows, null, 2);
}
