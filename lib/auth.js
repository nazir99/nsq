// OAuth 2.0 Machine-to-Machine (client credentials + signed JWT assertion).
// Builds a PS256-signed client assertion, exchanges it for a bearer access token.
import crypto from 'node:crypto';
import { request } from 'node:https';
import { loadPrivateKey, accountHost } from './config.js';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// NetSuite M2M requires PS256 or ES256. We use PS256 with the shared RSA key.
function signAssertion({ clientId, certId, host }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'PS256', typ: 'JWT', kid: certId };
  const payload = {
    iss: clientId,
    scope: 'rest_webservices',
    aud: `https://${host}/services/rest/auth/oauth2/v1/token`,
    iat: now,
    exp: now + 300, // 5 minutes
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: loadPrivateKey(),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return `${signingInput}.${base64url(signature)}`;
}

function postForm(host, path, formBody) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formBody).toString();
    const req = request(
      {
        host,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Returns a bearer access token for the given profile.
export async function getAccessToken(profile) {
  const host = accountHost(profile.accountId);
  const assertion = signAssertion({ clientId: profile.clientId, certId: profile.certId, host });
  const { status, body } = await postForm(host, '/services/rest/auth/oauth2/v1/token', {
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  });
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Token endpoint returned non-JSON (HTTP ${status}): ${body.slice(0, 400)}`);
  }
  if (status !== 200 || !parsed.access_token) {
    throw new Error(
      `Auth failed (HTTP ${status}): ${parsed.error || ''} ${parsed.error_description || body.slice(0, 400)}`
    );
  }
  return parsed.access_token;
}
