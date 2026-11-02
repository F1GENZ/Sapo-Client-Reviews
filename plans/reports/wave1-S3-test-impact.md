# Wave 1 S3 test impact (privacy / webhooks / purchase / schema)

Nothing was compiled or run. New tests: `test/s3-privacy-webhooks.test.ts` (typed, no network, no DB).

## Existing tests that break and must be updated by wave 2

### test/lifecycle.test.ts
- `:13` imports `SubscriptionService`, `installStatusFromSnapshot` from the deleted `src/sapo/subscription.service` - the whole file fails to load. Delete the import and the two subscription tests (`:425` `new SubscriptionService(...)`, `:452` `new SubscriptionService(..., fakePrisma)` and the `installStatusFromSnapshot` assertion at `:435`).
- `:265-273`, `:302-310`, `:345-353` `new WebhookService(...)`: the 4th positional argument (the `{ buildSnapshot, saveSnapshot, applySnapshotToInstall }` stub) is gone. New order: `(prisma, hmacVerifier, shopDomains, uninstallService, sapo, catalogSync, purchases)`. Drop the subscriptions stub and add a `purchases` stub (`{ toStoredOrder, syncOrder }`) where order topics run.
- `:370` `normalizeWebhookTopic('app_charge_update')` now returns `'unknown'`; `:378` `isKnownWebhookTopic('app/charge')` is now `false`; `:382` stays true. Update to the new expectations.

### test/durability.test.ts
- `:104-118` `makeWebhookService`: same constructor change (remove the `{}` 4th argument, keep `uninstall`, `sapo`, `catalogSync`, `purchases` in the new order). The `purchases` stub needs `toStoredOrder` (the `orders/*` webhook stores a projection); `{ syncOrder }` alone makes `orders/paid` throw.
- `:99` fake `appInstall.findUnique` returns only `{ shopId }`; that works (status undefined is not `uninstalled`, generation falls back to 0), but `orders/*` and `products/delete` events now query `prisma.catalogProduct.findFirst` / `prisma.customerPurchase.findFirst` for the cross-store id check. Add those two models to `makeWebhookDb` (return `null`).
- `:275-295` order tests (`orders/paid` with `{ syncOrder }` stub): the stub must also expose `toStoredOrder`; the retry-from-stored-payload assertion should expect the projected payload (no raw `email`/`phone`), not the original body.
- Any assertion on `row.payload` for order events (replay from stored payload) must read the projection (`id`, `line_items:[{product_id}]`, `email_hash`, `phone_hash`, `hash_version`).
- `:321` `registerForInstall` stub is fine; `SapoService` (S4) calls are unchanged.

### e2e/http-contract.cjs
- `:31` `eventIdHeader: "x-sapo-webhook-id"` and `:868`: the server no longer reads `x-sapo-webhook-id`, `x-sapo-id` or `x-request-id`. Switch to `x-sapo-event-id` or the idempotency checks that rely on distinct event ids for the same payload (`:906` `evt-orders-1`, `:952` `evt-unmapped`, `:954` `evt-mismatch`, `:964` `evt-uninstall-b`) will see byte-identical payloads as duplicates.
- `:964` U1/U3: `app/uninstalled` keys now include `lifecycleGeneration`; a second identical uninstall after reinstall runs again (expected).
- `:394` `app/charge must not be subscribed` stays valid.
- `:386-392` registration checks: registration now lists `/admin/webhooks.json` (GET) before POSTing, skips topics already registered at the same address and deletes stale own-endpoint addresses; the stub already serves GET/POST (no DELETE route - a stale address would hit `unexpected`; none are seeded).
- Order events for STORE_A now run the cross-store id check; the e2e Postgres has real tables so no stub change is needed.

### Other
- `e2e/lib/sapo-stub.cjs:173` `orders: []` is unaffected (`getOrders` is deleted and was never called).
- Any test constructing `PurchaseStoreService`, `UninstallService` (5 args now: no `subscriptions`), `DurabilitySweepService` (new last arg `PrismaService`) or `PurchaseStoreService` needs `env.DATA_ENCRYPTION_KEY` set to a valid non-sample key.

## Not finished / needs the controller
- `npx prisma generate` printed `EPERM ... rename query_engine-windows.dll.node` (another process holds the DLL). `index.js` and `index.d.ts` under `node_modules/.prisma/client` already contain `hashVersion` / `sourceUpdatedAt`, but the copy of `schema.prisma` in that directory and the engine rename were not completed. Re-run `npx prisma generate` once nothing holds the engine (stop the running app/dev server), before the gate.
- Background limiter in `sapo-api.service.ts` (`bg` argument, `background` state, `SAPO_API_MIN_INTERVAL_MS`) is unreachable after `runBackground` was deleted (every call passes `bg=false`). Left in place because `SAPO_API_MIN_INTERVAL_MS` lives in `src/config/**` (S4) and docs; remove both together in a follow-up if wanted.
- `webhookReceiverUrl` was kept: it is now the single URL builder used by `registerForInstall`.
