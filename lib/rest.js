// Read-only GET against NetSuite's REST record metadata catalog. This is the only
// part of the record API nsq touches: the path is checked here, not trusted from
// callers, so no other record endpoint can be reached through this helper.
import { request } from 'node:https';
import { accountHost } from './config.js';

const METADATA_PREFIX = '/services/rest/record/v1/metadata-catalog';

export function checkMetadataPath(path) {
  const bare = String(path).split('?')[0];
  if (bare !== METADATA_PREFIX && !/^\/services\/rest\/record\/v1\/metadata-catalog\/[A-Za-z0-9_]+$/.test(bare)) {
    throw new Error(`refusing ${path}: nsq only reads ${METADATA_PREFIX}[/<record>]`);
  }
}

export function getMetadata({ profile, token, path, accept = 'application/json' }) {
  checkMetadataPath(path);
  const host = accountHost(profile.accountId);
  return new Promise((resolve, reject) => {
    const req = request(
      { host, path, method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: accept } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            return reject(new Error(`metadata GET ${path} returned non-JSON (HTTP ${res.statusCode}): ${data.slice(0, 300)}`));
          }
          if (res.statusCode !== 200) {
            const detail = parsed?.['o:errorDetails']?.map((d) => `${d['o:errorCode'] || ''}: ${d.detail}`).join('\n') || parsed.title || data.slice(0, 300);
            const err = new Error(`metadata GET ${path} failed (HTTP ${res.statusCode}): ${detail}`);
            err.status = res.statusCode;
            return reject(err);
          }
          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}
