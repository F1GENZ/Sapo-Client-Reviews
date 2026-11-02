# Wave 1 S4 test impact (config / auth / secrets)

New file: `test/s4-config-auth.test.ts` (secret guard, loadEnv, TRUST_PROXY, constructor guards, `gen` claim, HttpOnly cookie, ShopAuthGuard gen mismatch).

## Existing tests that break or need an update (wave 2 owner)

- `test/lifecycle.test.ts:155` `sessions.createSessionToken('demo.mysapo.net')` has no generation, so the token carries `gen: undefined` and `verifySessionToken` throws `Invalid auth session`. Pass a generation (`createSessionToken('demo.mysapo.net', 1)`); the forged-expiry case at :164-169 re-signs the decoded body and keeps `gen`, so it works after that change.
- `test/security.test.ts:335` `sessions.createSessionToken('demo.mysapo.net')` same signature change; the token must carry a numeric generation.
- `test/security.test.ts:323` `makeGuard` sapo mock only has `resolveAccessToken`; `ShopAuthGuard` now calls `sapoService.getLifecycleGeneration(storeDomain)` first. Add `getLifecycleGeneration: async () => <same gen as the token>`.
- `test/durability.test.ts:304-311` (`runInstall`) prisma mock has no `$transaction`; `SapoService.processInstallCallback` now always calls `this.prisma.$transaction([updateMany, upsert])` per domain (the `typeof $transaction === 'function'` fallback and the `typeof appInstall.findUnique === 'function'` guard were removed). Add `$transaction: async (ops) => Promise.all(ops)` to the mock and make `updateMany`/`upsert` return values.
- `test/durability.test.ts:312-323` `runInstall` passes `{ SAPO_CLIENT_ID: 'id' }` as env; unchanged behaviour, but the mock `registerForInstall`/`writeStorefrontConfig` now get a `.catch` that logs; both mocks already return promises so nothing breaks.
- `test/lifecycle.test.ts:486-487` constructs `SessionService`/`TokenEncryptionService` with `makeEnv()`; its values pass the guards (secret 42 bytes, key `Buffer.alloc(32, 7)`), nothing to change.
- Any test building `HmacVerifierService`/`SessionService`/`TokenEncryptionService` with an empty or `replace-with-*` secret now throws in the constructor (none found in `test/` or `e2e/` today).
- `e2e/http-contract.cjs`: env uses `TRUST_PROXY: "false"`, random non-placeholder secrets, a 64-hex encryption key; passes the new `loadEnv`. The real `session/exchange` flow works because the install row supplies the generation.

## Not finished / reported

- S-46 server half: `SessionService.cookieOptions` already sets `httpOnly: true` for the `sapo_app_session` cookie, so the server cookie is not JS-readable. The JS-readable `auth_session_token` cookie is written only by `client/src/common/AuthStorage.js` (slice S6). No server change was needed. `setSessionCookie` now takes the token string (`setSessionCookie(res, sessionToken)`), so cookie and JSON body carry the same token.
- Forced re-login: every pre-existing session JWT lacks `gen` and is rejected once after deploy.
- `docs/env-contract.md` / `deploy-sapo.md` still describe the old guards (docs slice I).
