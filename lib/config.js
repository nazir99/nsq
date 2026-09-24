// Loads secrets/profiles from ~/.netsuite-query/, kept out of every repository.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SECRET_DIR = join(homedir(), '.netsuite-query');
export const ACCOUNTS_PATH = join(SECRET_DIR, 'accounts.json');
export const PRIVATE_KEY_PATH = join(SECRET_DIR, 'private.pem');

export function ensureSecretDir() {
  if (!existsSync(SECRET_DIR)) mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
}

export function loadAccounts() {
  if (!existsSync(ACCOUNTS_PATH)) return {};
  return JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8'));
}

export function saveAccounts(accounts) {
  ensureSecretDir();
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2) + '\n', { mode: 0o600 });
}

// Look up one profile by alias. Each profile: { accountId, clientId, certId }
export function getProfile(alias) {
  const accounts = loadAccounts();
  const p = accounts[alias];
  if (!p) {
    const known = Object.keys(accounts);
    throw new Error(
      `Unknown account "${alias}". ` +
        (known.length ? `Configured: ${known.join(', ')}` : 'No accounts configured yet. Run: nsq accounts add')
    );
  }
  for (const field of ['accountId', 'clientId', 'certId']) {
    if (!p[field]) throw new Error(`Account "${alias}" is missing "${field}" in ${ACCOUNTS_PATH}`);
  }
  return p;
}

export function loadPrivateKey() {
  if (!existsSync(PRIVATE_KEY_PATH)) {
    throw new Error(`Private key not found at ${PRIVATE_KEY_PATH}. Generate it (see README).`);
  }
  return readFileSync(PRIVATE_KEY_PATH, 'utf8');
}

// NetSuite host: account id lowercased, underscores -> hyphens (e.g. 1234567_SB1 -> 1234567-sb1)
export function accountHost(accountId) {
  const id = String(accountId).toLowerCase().replace(/_/g, '-');
  return `${id}.suitetalk.api.netsuite.com`;
}

// "production" or "sandbox". An explicit profile.env wins; otherwise sandbox and
// release-preview account ids (1234567_SB1, 1234567_RP) are sandbox and everything
// else is treated as production, so an unlabeled profile is guarded, not trusted.
export function accountEnv(profile) {
  if (profile.env === 'production' || profile.env === 'sandbox') return profile.env;
  return /_(SB\d*|RP)$/i.test(String(profile.accountId)) ? 'sandbox' : 'production';
}
