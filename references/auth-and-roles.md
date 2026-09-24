# Auth and roles

nsq authenticates with OAuth 2.0 Machine-to-Machine (client credentials with a
signed JWT). One RSA key pair can serve every account; each account maps the public
certificate to an integration, an entity and a role.

## What limits what

- **Scope** limits which APIs a token opens. nsq always requests
  `rest_webservices`, which covers SuiteQL and also the REST record API.
- **Role** limits what the token can do once inside. With an Administrator role a
  `rest_webservices` token can create and change records. **The role is the real
  guardrail.** Map nsq's certificate to a read-only role.

## A read-only role for nsq

Create a custom role (Setup > Users/Roles > Manage Roles > New):

- Center type Classic; not "Web Services Only Role".
- Setup permissions: **REST Web Services (Full)** and **Log in using OAuth 2.0 Access
  Tokens (Full)**. SOAP Web Services is not enough.
- Lists, Transactions, Reports: **View** only, for the records you query.
- Subsidiary restriction: all subsidiaries you report on (a restricted role returns
  short results without an error).
- No Create, Edit or Full on any record.

Then map the certificate to this role, not to Administrator. One mapping exists per
integration + entity + role + certificate. Test that it cannot write: a REST record
POST should fail with `INSUFFICIENT_PERMISSION`.

## Writes and RESTlets are not nsq

If work needs to create records or call a RESTlet, that is a separate integration
with its own role, certificate and review. Never reuse nsq's key, never change the
JWT scope, never sign tokens by hand. A RESTlet needs the `restlets` scope and
returns `INVALID_LOGIN_ATTEMPT` with the wrong one.

## Key and certificate

- RSA 4096-bit (2048 is rejected with "invalid bit length"); signature PS256.
- Certificates last at most two years; note the expiry.
- The private key lives in `~/.netsuite-query/private.pem` (mode 600) and never in a
  repository, a vault, or a chat.

Setup steps are in the README.
