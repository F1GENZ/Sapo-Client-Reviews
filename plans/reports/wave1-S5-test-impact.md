# Wave 1 S5 test impact (media / worker / redis / security)

Wave 2 test owner: update these existing assertions. New tests live in `test/s5-media-infra.test.ts` (covers tickets, MP4 brand sniffing, key naming, daily cap, Redis fallback, memory cap, Worker limits).

## test/security.test.ts

- :450, :456-457 `ticketInput`/`verifyInput` carry `filename`. Harmless (createUploadTicket ignores it) but drop it from `verifyInput`.
- :474 `(await media.verifyUploadTicket(...)).filename === 'photo.png'` fails: the ticket payload no longer has `filename`. Assert `.productId`/`.nonce` instead.
- :496 hand-built no-nonce ticket still has `filename`; it stays rejected (`Invalid upload ticket`, now 401 and signed with the raw secret, not the derived key). Remove `filename` for tidiness.
- :514-515 `/Invalid filename/` assertions fail: `validateFilename` is deleted, the field is ignored. Delete both lines (or assert `createUploadTicket` succeeds with an arbitrary/undefined filename).
- :531-538 `media.uploadFile(store, '123', 'a.jpg', 'image/jpeg', PNG)` uses the old 5-arg order. New signature: `uploadFile(storeDomain, productId, nonce, contentType, buffer)` (nonce = ticket nonce, `/^[A-Za-z0-9_-]{16,64}$/`). The upload URL is now `.../reviews/<store>/<productId>/<nonce>.<ext>` (ext from sniffed type: jpg|png|webp|mp4), not `<id>/<safeName>`. Update :538 regex and the `my photo.png` case.
- :470-472 `/mismatch/` still matches (now 403 `upload_ticket_mismatch`); :475 `/already used/` still matches (409). :487-493 `/Invalid upload ticket/`, `/Missing upload ticket/`, `/expired/` still match (401). `assert.rejects(..., BadRequestException)` style checks for these would fail; the regex ones do not.
- :569-580 gate tests: regex messages unchanged but exceptions are now `UnauthorizedException` (missing/invalid/expired ticket) and `ForbiddenException` (store mismatch). :569-570 (missing/invalid store domain) remain `BadRequestException`.
- :620-636 `PresignDto` table: `filename` is now optional with `@IsString @MaxLength(1024)`; the `Length(1,255)` rows at :625 (`filename: ''`) and :626 (256 chars) are now valid. `@Max(5 MB)` was removed from `fileSize`, so :630 (`IMAGE_MAX_SIZE_BYTES + 1`) is now valid at the DTO and rejected by `validateUploadInput` as 413 (`PayloadTooLargeException`). Move those rows to a service-level assertion.
- :502-516 `validateUploadInput` too-large errors are now `PayloadTooLargeException` (413) not `BadRequestException`; the `/Max 5MB/`, `/Max 2MB/` regexes still match. The loop at :509-511 (bad sizes -> `BadRequestException`) is unchanged and still passes.

## Not run / open items

- `PublicMediaController.createTicket` now calls `ReviewService.getServingWidgetConfig(storeDomain)` (contract, S1). It will not compile or run until S1 adds it; any controller-level test fakes need that method.
- `Missing/not configured` secret paths now return 503 (`upload_not_configured`) instead of 400.
- Worker: `Content-Length` is now mandatory (411) and keys must match `reviews/<store>/<productId>/<nonce>.<ext>` with the extension matching the content type. Any e2e that PUTs directly to the Worker must follow this.
- DELETE/list on the Worker and orphan sweep are wave 2 slice J and are not implemented.
