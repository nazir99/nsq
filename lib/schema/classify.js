// Which layer a table or column belongs to: standard NetSuite (public graph),
// an Oracle SuiteApp on the allowlist (public suiteapp layer), or the account's
// own customization (local cache only). When in doubt, it is local.

// Standard tables whose ids happen to start with "custom".
const STANDARD_CUSTOM_NAMES = new Set([
  'customrecordtype',
  'customrecordactionscript',
  'customtransactiontype',
  'customtransactionstatus',
]);

const CUSTOM_TABLE = /^(customrecord|customlist|customtransaction|cseg)/;
// Custom field ids can sit anywhere in a column id (matrixoptioncustitem_x).
const CUSTOM_COLUMN = /(^|matrixoption)cust(body|col|item|entity|event|record|itemnumber|page)|cseg/;

export function lower(id) {
  return String(id || '').toLowerCase();
}

function hasClientPrefix(id, clientPrefixes = []) {
  const s = lower(id);
  return clientPrefixes.some((p) => p && s.includes(lower(p)));
}

export function isCustomTable(id, clientPrefixes = []) {
  const s = lower(id);
  if (hasClientPrefix(s, clientPrefixes)) return true;
  if (STANDARD_CUSTOM_NAMES.has(s)) return false;
  return CUSTOM_TABLE.test(s);
}

export function isCustomColumn(id, clientPrefixes = []) {
  const s = lower(id);
  return hasClientPrefix(s, clientPrefixes) || CUSTOM_COLUMN.test(s);
}

// Oracle SuiteApp tables keep the same ids in every account. suiteapps maps an
// id prefix (after customrecord_ / customlist_ / customtransaction_) to the app.
export function suiteappOf(id, suiteapps = {}, clientPrefixes = []) {
  const s = lower(id);
  if (hasClientPrefix(s, clientPrefixes)) return null;
  const m = s.match(/^(customrecord|customlist|customtransaction)_([a-z0-9]+)_/);
  if (!m) return null;
  return suiteapps[m[2]] || null;
}

// Columns of a SuiteApp table: its own custrecord_ fields stay, but anything the
// client added (client prefix, custom segments, other custom field families) is local.
export function isSuiteappColumnPublic(id, clientPrefixes = []) {
  const s = lower(id);
  if (hasClientPrefix(s, clientPrefixes)) return false;
  if (/^custrecord_/.test(s)) return true;
  return !CUSTOM_COLUMN.test(s);
}

export function featureOf(id, features = []) {
  const s = lower(id);
  for (const [pattern, name] of features) if (new RegExp(pattern).test(s)) return name;
  return null;
}

// 'standard' | 'suiteapp' | 'custom'
export function tableLayer(id, { clientPrefixes = [], suiteapps = {} } = {}) {
  if (!isCustomTable(id, clientPrefixes)) return 'standard';
  return suiteappOf(id, suiteapps, clientPrefixes) ? 'suiteapp' : 'custom';
}
