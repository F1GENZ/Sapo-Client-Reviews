## Kết quả hợp nhất (RevVerifier)

Không có Critical. Chuỗi gõ đối chiếu theo lệnh (a)–(d) nằm ở cuối phần findings. Tag: `[CODE]` áp thẳng được, `[CODE+TEST]` phải sửa kèm test, `[DOCS]` chỉ sửa tài liệu, `[LIVE]` cần dữ kiện chạy thật.

---

**V-1 [High] [CODE] Guard thứ tự đơn hàng đọc `updated_on`/`updated_at`, nhưng Sapo gửi `modified_on`**
- Where: `src/purchase/purchase-store.service.ts:58`, `:316-320`, guard `:372-378`. Fixture: `test/s3-privacy-webhooks.test.ts:29,76-77`.
- Evidence: Trang chính thức https://support.sapo.vn/cac-thuoc-tinh-cua-order-api liệt kê `created_on`, `processed_on`, `cancelled_on`, `closed_on` và `modified_on` ("Thời gian Order được cập nhật lần cuối"). Trang không có `updated_on` hay `updated_at`. Repo không có chuỗi `modified_on` nào. `plans/reports/problem-solving-winner-D.md:94` ghi "Field names are still unproven". Không có payload đo thật trong repo.
- Scenario: Payload thật cho `sourceUpdatedAt = null`, nên guard `:372` không chạy. Nhánh update vẫn ghi `cancelledAt`, `refundedAt` và các cột status. Một `orders/updated` hay `orders/paid` cũ, xử lý muộn hoặc retry từ bản chiếu đã lưu, sẽ đè lên `orders/cancelled`. Đơn đã hủy lại đủ điều kiện "verified buyer". `toStoredOrder` (`:276-282`) cũng không lưu `modified_on`, nên retry mất luôn tín hiệu thứ tự.
- Fix: Thêm `'modified_on'` lên đầu `ORDER_TIMESTAMP_FIELDS.updated`. Vòng lặp trong `toStoredOrder` tự lưu key mới. Đổi fixture `test/s3-privacy-webhooks.test.ts:29,76-77` sang `modified_on`. Thêm một test chỉ có `modified_on`.
- Found-by: D. Confidence: VERIFIED (tài liệu Sapo và code). Chưa đo payload webhook thật, nhưng việc đó không chặn bản sửa.

**V-2 [High] [CODE+TEST] Bucket đọc theo store (600/phút) thấp hơn bucket theo client (900/phút), nên một client DoS được cả store**
- Where: `src/common/security/public-rate-limit.ts:8-9,16-20,36-43`; `src/common/security/security-headers.ts:41` (`no-store`). Widget: `storefront/snippets/f1genz-storefront.js:430,549,564,622`.
- Evidence: Key lấy từ `x-store-domain` hoặc `?storeDomain`, chỉ qua regex, không kiểm tra store đã cài. Mỗi GET dưới `/api/public` tính vào `public-read-store:<domain>`. Mỗi lượt xem trang sản phẩm gọi tối thiểu config, reviews, qna và summary(ies). `test/security.test.ts:289-308` khóa cứng hành vi này: nhiều IP khác nhau làm cạn bucket store rồi nhận 429.
- Scenario: Một IP gửi 10 GET/s kèm `X-Store-Domain: victim.mysapo.net`, chưa chạm cap 900. Mọi khách thật của store đó nhận 429 và widget không hiện. Không cần kẻ tấn công: khoảng 150 lượt xem trang/phút đã đủ làm cạn bucket vào giờ cao điểm.
- Fix: Cách ưu tiên là bỏ bucket store cho GET. Xóa nhánh store ở `:36-43`, `PUBLIC_READ_SHOP_LIMIT`, case tương ứng ở `test/security.test.ts:~296-308`, và số 600 ở `docs/architecture-contracts.md:92` + `docs/env-contract.md:92`. Giữ export `resolveStoreScope` vì `public-media.guard.ts` còn import. Cách tối thiểu: nâng `PUBLIC_READ_SHOP_LIMIT` lên ít nhất 10 lần `PUBLIC_READ_CLIENT_LIMIT` và sửa hai dòng docs. Tùy chọn: bỏ `no-store` cho GET cấu hình/summary để CDN hấp thụ tải.
- Found-by: A (High), B (Medium). Mức High do cả vector tấn công lẫn tải tự nhiên. Confidence: VERIFIED.

**V-3 [Medium] [CODE+TEST] Allowlist media chỉ theo store; xóa review và sweep mồ côi bỏ qua tham chiếu khác**
- Where: `src/review/public-review-input.ts:62,72`; `src/review/review.service.ts:800-801,935`; `src/media/media.service.ts:296-309`; `src/ops/durability-sweep.service.ts:148-159,163`.
- Evidence: `sanitizePublicMedia` chỉ yêu cầu host đúng và `pathname.startsWith('/reviews/<store>/')`, không xét product hay người upload. `deleteByUrls` xóa mọi URL của hàng review, chỉ kiểm tiền tố store. Sweep gom `scopes` theo `shopId:productId` suy từ key và chỉ tìm tham chiếu trong các hàng đó.
- Scenario: (1) URL ảnh khách công khai trên review đã duyệt. Kẻ lạ gửi review khác (cùng hoặc khác product) chứa URL đó. Chủ shop xóa review spam thì ảnh thật bị xóa khỏi R2. (2) Review product B trỏ tới object dưới product A: sweep không thấy tham chiếu và xóa object sau 24 giờ.
- Fix: (a) Truyền `productId` vào scope của `sanitizePublicMedia` (nơi gọi ở `public-review.controller.ts`) và yêu cầu tiền tố `/reviews/<store>/<productId>/`. Cập nhật test. (b) Trước `deleteByUrls` ở `:800,935`, bỏ URL còn được review khác cùng `shopId` + `productId` tham chiếu, ví dụ `reviewProduct.findMany({ where: { shopId, productId, reviewId: { not }, media: { not: DbNull } } })`. Sau (a), việc dùng chung chỉ còn trong cùng product, nên kiểm tra theo product là đủ. Chỉ làm (a) thì kịch bản cùng product vẫn còn.
- Found-by: A, B. Confidence: VERIFIED (tĩnh); khai thác cần request tự chế.

**V-4 [Medium] [CODE+TEST] `R2_UPLOAD_SECRET` không bị chặn placeholder hay độ dài, nhưng giờ ủy quyền cả DELETE/list ở Worker**
- Where: `src/config/env.schema.ts` (`PLACEHOLDER_CHECK_KEYS` và khối `checkSetSecret` trong `loadEnv`); `src/media/media.service.ts:147-151` (`ticketSecret` chỉ kiểm truthy); `worker/src/index.js:24-28`; `.env.example` (`replace-with-upload-secret`).
- Evidence: Chỉ `SAPO_CLIENT_SECRET`, `APP_SESSION_SECRET`, `DATA_ENCRYPTION_KEY` được `assertUsableSecret`. Secret này cũng là khóa gốc ký ticket upload.
- Scenario: Sao chép `.env.example` lên production vẫn boot được. Token Worker khi đó là công khai: ai cũng `GET /list` và `DELETE` được ảnh mọi store, và ký được ticket giả.
- Fix: Trong `loadEnv`, khi `R2_UPLOAD_SECRET` có giá trị, gọi `checkSetSecret(() => assertUsableSecret('R2_UPLOAD_SECRET', v, { minBytes: 32 }))` ở mọi `NODE_ENV`. Nâng `e2e/http-contract.cjs:58` lên `randomSuffix(16)` (hiện khoảng 30 ký tự). Unit test truyền `fake<AppEnv>` thẳng vào `MediaService`, không qua `loadEnv`. Thêm một dòng vào `docs/env-contract.md`. Tùy chọn: bắt buộc cả ba biến R2 cùng đặt hoặc cùng bỏ.
- Found-by: A. Confidence: VERIFIED về lỗ hổng; tác động phụ thuộc vận hành.

**V-5 [Medium] [DOCS]+[LIVE] Lần deploy đầu lên DB đã có bảng: migration init mới, không có hướng dẫn baseline**
- Where: `prisma/migrations/202607050000_init/migration.sql:1-12`; `.github/workflows/deploy.yml` (`npm run db:migrate`); `docs/deploy-sapo.md` (mục Server Deploy); `README.md:30`.
- Evidence (b): `git log --all -- prisma/migrations` chỉ có commit `eea8092` (đổi tên từ `server/prisma/...`) và `772a840`. Migration duy nhất từng commit là `202607051500_active_domain_unique`, và nó chỉ có `CREATE UNIQUE INDEX IF NOT EXISTS ... ON "ShopDomain"`, không chạy được trên DB rỗng. Init (`CREATE TYPE`/`CREATE TABLE` thường), `202607301000_*` và `202610310000_*` đều là file mới (`A`) chưa commit. Vậy schema live, nếu có, được tạo ngoài migrate. Docs giả định DB mới ("own Postgres database").
- Scenario: Nếu DB đã có bảng, `migrate deploy` báo P3005, hoặc `CREATE TYPE "AppStatus"` fail "already exists" rồi P3009 chặn mọi lần deploy sau. Deploy an toàn: `dist.prev` được snapshot trước migrate và `set -e` dừng trước khi swap build, nên app đang chạy không bị ảnh hưởng.
- Phụ: `.env` dựng từ `.env.example` cũ dùng key mẫu công khai; code mới từ chối khởi động. Đổi key làm token đã mã hóa và hash email/SĐT không đọc được, chưa có tài liệu nói phải cài lại từng store. Object R2 cũ có dạng `reviews/<store>/<pid>/<8byte>/<file>` không khớp `OBJECT_KEY_RE` nên không bao giờ bị xóa hay sweep (HEAD cũng không có DELETE, nên không phải hồi quy).
- Fix: Thêm mục bootstrap vào `docs/deploy-sapo.md`: kiểm tra schema rồi `npx prisma migrate resolve --applied 202607050000_init` (và `202607051500_active_domain_unique` nếu thiếu), kèm hệ quả khi đổi key mã hóa và ghi chú về object R2 cũ. Làm rõ ở `README.md:30` rằng quy tắc "không test trên DB thật" áp cho `migrate dev`.
- Found-by: A, C, D (D chấm High, A và C chấm Medium). Mức Medium vì deploy fail an toàn. Confidence: SUSPECTED. Cần xác nhận DB production đã có bảng hay chưa.

**V-6 [Medium] [CODE] Dropdown sản phẩm ở trang Reviews hiện "N đánh giá · undefined sao"**
- Where: `client/src/components/ProductSearch.jsx:209`; `src/dashboard/dashboard.service.ts:301-306`; `client/src/pages/reviews/index.jsx:177-184,743-749`.
- Evidence: Server trả `productStats[].avgRating`; `reviewAvg` chỉ có ở `attentionProducts`. Trang Reviews không truyền `statsRenderer` nên renderer mặc định đọc `stats.reviewAvg`. HEAD không trả `productStats` (không có trong `dashboard.service.ts`), nên bản patch lần đầu cấp dữ liệu với key lệch.
- Scenario: Mọi sản phẩm có review đều hiện "2 đánh giá · undefined sao".
- Fix: Renderer mặc định dùng `(stats.avgRating ?? stats.reviewAvg)` có `Number(...).toFixed(1)`. Thêm assertion vào journey V1 hoặc N-series.
- Found-by: E. Confidence: VERIFIED.

**V-7 [Medium] [CODE+TEST]+[LIVE] Bucket rate-limit theo IPv6 /128, đổi địa chỉ trong /64 là có bucket mới**
- Where: `src/common/security/client-fingerprint.ts:3-4` (giống HEAD); dùng ở `public-rate-limit.ts:35`, `public-review.controller.ts`, `public-qna.controller.ts`, `public-media.guard.ts`.
- Evidence: Fingerprint là `req.ip` nguyên bản.
- Scenario: Client có /64 xoay địa chỉ mỗi request, nên mọi limit 20/120/900 mất tác dụng. Spam review/Q&A và trần upload hằng ngày thành vô hạn.
- Fix: Với IPv6, gộp về 64 bit đầu (giữ nguyên IPv4 và `::ffff:a.b.c.d`). Thêm test.
- Found-by: B. Confidence: SUSPECTED. Cần biết origin có nhận IPv6 client qua `TRUST_PROXY` (Cloudflare) hay không.

**V-8 [Medium] [CODE+TEST] Test retention/orphan sweep không thể phát hiện xóa quá tay**
- Where: `test/s3-privacy-webhooks.test.ts:408-451`; `test/w2-media-deletion.test.ts:324-350`.
- Evidence: `tx.appInstall.findFirst` luôn trả `{id}`; `customerPurchase.deleteMany` và `webhookEvent.deleteMany` bỏ qua tham số. Chỉ khẳng định `installFilter.status === 'uninstalled'`. Cutoff 30/90 ngày, `nextRetryAt: null`, phạm vi `shopId`/`resolvedStoreDomain` không bị kiểm. `filters` ghi lại `where` của webhookEvent nhưng không assert.
- Scenario: `deleteMany` không scope, cutoff bằng 0 hoặc mất `nextRetryAt: null` vẫn xanh trên đường xóa nguy hiểm nhất của app.
- Fix: Bắt `where` của mọi `deleteMany`/`findFirst`, inject `now`, assert cutoff `lt` và scope. Ở harness w2, cho `findMany` tôn trọng `where`.
- Found-by: C. Confidence: VERIFIED.

**V-9 [Medium] [CODE+TEST] Kiểm tra sở hữu chéo store quét cả bảng trên mỗi webhook order/delete**
- Where: `src/sapo/webhook.service.ts:147-168` (`customerPurchase.findFirst({ where: { orderId, shopId: { not } } })` và `catalogProduct.findFirst({ where: { productId, shopId: { not }, deletedAt: null } })`); `prisma/schema.prisma:201-204,229-233`.
- Evidence: Mọi index của `CustomerPurchase` và `CatalogProduct` đều bắt đầu bằng `shopId`; không có index nào dẫn đầu `orderId` hay `productId`.
- Scenario: Trường hợp bình thường không khớp dòng nào, nên Postgres đọc cả `customer_purchases` (một dòng mỗi line item, của mọi merchant) trước khi lưu event. Chi phí tăng theo tổng lịch sử.
- Fix: Thêm `@@index([orderId])` vào `CustomerPurchase` và `@@index([productId])` vào `CatalogProduct`. Sinh SQL migration mới bằng `npx prisma migrate diff --from-schema-datamodel <schema HEAD> --to-schema-datamodel prisma/schema.prisma --script`, không đặt tên tay. Đặt thành migration mới, không sửa init.
- Found-by: D. Confidence: VERIFIED (schema + code). Mức độ tăng theo dữ liệu.

**V-10 [Low] [CODE+TEST] Whitelist public-response và header `/api` bị vượt qua bằng đổi hoa/thường hay percent-encoding đường dẫn**
- Where: `src/common/security/public-response.ts:15-16,59-63`; `src/common/security/security-headers.ts` (kiểm tra `startsWith('/api/')`); `src/review/review.service.ts:239-243`; `src/qna/qna.service.ts:76-80`.
- Evidence: Interceptor khớp `req.path` bằng regex chữ thường. Không có `case sensitive routing` nào trong `src`/`test`/`e2e`, nên Express định tuyến `/Api/Public/Reviews/123` và `/api/public/reviews/%31%32%33` vào cùng controller. `req.path` giữ nguyên chuỗi gốc, nên regex không khớp và body qua nguyên vẹn. `toPublicReview`/`toPublicQuestion` chỉ xóa `email`/`phone`.
- Scenario: Tác động thực tế hiện giờ: không có chỗ nào ghi `source_raw_json` ≠ null (chỉ sao chép từ bản ghi sẵn có), nên chỉ lộ nếu DB có hàng nhập từ nguồn khác. Docs gọi interceptor là "last gate", là sai cho các biến thể này. Hạ từ Medium (B) xuống Low vì chưa có dữ liệu rò thật.
- Fix: Thêm `delete review.source_raw_json` và `delete question.source_raw_json` vào hai hàm map public. Trong `PublicResponseInterceptor` và `applySecurityHeaders`, chuẩn hóa đường dẫn trước khi so (decode an toàn bằng try/catch rồi lowercase). Thêm test cho `/API/PUBLIC/...` và `%31`.
- Found-by: B. Confidence: VERIFIED (cơ chế); chưa chạy request.

**V-11 [Low] [CODE+TEST] Ở store không bật cổng mua hàng, submit vẫn tra mua hàng và lưu `verified` công khai mà không tính throttle danh tính; throttle SĐT đếm trùng**
- Where: `src/review/review.service.ts:~685-693` (`if (gated) await hooks.chargeIdentity`; `verified = hasIdentity ? lookupPurchase(...)`); `src/review/public-review.controller.ts` (digest `phone.replace(/\D/g, '')`, `~:88`); `src/purchase/purchase-store.service.ts:~145` (`normalizePhone` đổi `+84…` thành `0…`).
- Evidence: `verified` nằm trong `REVIEW_FIELDS` công khai. `0901234567` và `+84901234567` cùng khớp một đơn nhưng ra hai digest khác nhau, nên budget 30/giờ nhân đôi. `toPublicSubmission` không trả `verified`, nên chỉ lộ qua danh sách công khai.
- Scenario: Cần `autoApprove` bật và cổng tắt. Kẻ gửi review với email dò rồi đọc cờ `verified` của review đã duyệt: oracle "email này đã mua sản phẩm này" bị giới hạn bởi budget per-client (và V-7).
- Fix: Gọi `chargeIdentity` bất cứ khi nào `hasIdentity`, không chỉ khi `gated`. Băm theo `normalizePhone` đã export. Cần xem `test/review-public-gates.test.ts` có khẳng định `chargeIdentity` không được gọi khi tắt cổng hay không.
- Found-by: B. Confidence: VERIFIED (cơ chế).

**V-12 [Low] [CODE] Lỗi 401 của ticket upload đăng xuất admin khỏi SPA**
- Where: `client/src/hooks/useMediaUpload.js:29-39`; `client/src/config/AxiosConfig.js:93-95`; `src/media/media.service.ts:183,187,194,198,201`. Người dùng: `ReviewCard.jsx:113`, `ReviewForm.jsx:84`.
- Evidence: HEAD ném `BadRequestException` (400) cho các lỗi ticket; patch đổi sang 401. Request upload dùng `httpClient` không có `skipAuthRedirect`, nên interceptor xóa session và chuyển tới `/install/login`.
- Scenario: Ticket hết hạn (TTL 2 phút, kiểm ở guard trước khi đọc body) hoặc đổi secret giữa chừng khi admin đang up ảnh làm mất form và bắt đăng nhập lại.
- Fix: Thêm `skipAuthRedirect: true` vào config request `/api/public/media/upload` trong `useMediaUpload.js`.
- Found-by: E. Confidence: VERIFIED (theo đường code). Hiếm gặp nên hạ Low.

**V-13 [Low] [CODE+TEST] Backfill coi `synced` (đếm cả bản trùng) là bằng chứng enumerate đủ, rồi soft-delete hàng thiếu**
- Where: `src/catalog/catalog-sync.service.ts:121-124,134-150`; `src/catalog/catalog-product-store.service.ts:177-180,351-380`.
- Evidence: `synced >= totalCount` dừng vòng với `stopReason='completed'`. Nếu phân trang theo offset bị dịch do một sản phẩm bị xóa giữa chừng, một sản phẩm còn sống có thể bị bỏ sót và bị đánh dấu xóa (chỉ áp cho hàng `source:'sapo'`). Chỉ backfill mới revive được (`row.source === 'sapo'`), webhook update thì không. Sau đó `submitPublicReview` trả `product_not_found`.
- Scenario: Cần xóa sản phẩm đúng lúc backfill đang chạy. Hiếm nhưng chặn review của sản phẩm sống cho tới backfill kế tiếp.
- Fix: Đổi điều kiện hoàn tất sang `seenProductIds.size >= totalCount`. Bỏ qua bước reconcile khi `totalCount !== null && seenProductIds.size < totalCount`. Không cho webhook revive: việc đó phá tính "delete là sticky" ghi ở plan F12. Cập nhật `test/durability.test.ts:~876`.
- Found-by: A. Confidence: SUSPECTED (phụ thuộc hành vi offset của Sapo).

**V-14 [Low] [CODE+TEST] Retry sự kiện sau uninstall/reinstall: `app/uninstalled` cũ có thể xóa cài đặt mới; event đã bị xóa payload bị đánh dấu `processed`**
- Where: `src/sapo/webhook.service.ts:~215-221` (key kèm generation), `:424-460` (`retryDueFailed`); `src/sapo/uninstall.service.ts` (`payload: Prisma.DbNull` cho mọi event của store).
- Evidence: `retryDueFailed` phát lại event qua `dispatch` không kiểm tra generation hay thời điểm cài. `UninstallService.uninstall` luôn vô hiệu hóa token và tăng generation. Uninstall xóa payload của cả event `failed` còn lịch retry; sau reinstall, retry gọi `sync*` với `{}`, chỉ log "no id" rồi bị ghi `processed`.
- Scenario: Event uninstall fail (ví dụ 409 do lock) rồi retry sau 2 phút, đúng lúc merchant vừa cài lại. Hiếm.
- Fix: Với event lifecycle lúc retry, so `row.receivedAt` với `install.installedAt` và đánh dấu `ignored` nếu event cũ hơn. Với hàng có `payload` null, ghi `failed` + `lastError='payload purged'` + `nextRetryAt: null` thay vì chạy.
- Found-by: D. Confidence: SUSPECTED (D-R4), VERIFIED bằng đọc code (D-R5).

**V-15 [Low] [CODE]+[LIVE] JSON-LD tự mount lấy product id đầu tiên bất kỳ trong DOM**
- Where: `storefront/snippets/f1genz-storefront.js:2775-2790,2828-2870` (`findPageProductId`, `mountProductSchema`).
- Evidence: Lấy phần tử đầu khớp `f1genz-rating-badge[product-id]`, rồi `[data-product-id]` đầu tiên, rồi `.sapo-product-reviews-badge[data-id]` trên toàn document. Tên/URL/ảnh lấy từ `og:*` của trang hiện tại.
- Scenario: Nếu khối sản phẩm liên quan nằm trước và có `data-product-id`, JSON-LD ghép tên sản phẩm này với `aggregateRating` của sản phẩm khác.
- Fix: Chỉ tự mount khi id lấy được khớp `og:url`/canonical, hoặc bỏ nhánh `[data-product-id]` chung và yêu cầu `f1genz-product-schema` tường minh. Cần xem DOM theme Sapo thật.
- Found-by: E. Confidence: SUSPECTED.

**V-16 [Low] [CODE+TEST] Widget nhận mọi link video HTTPS, server âm thầm bỏ nếu không phải YouTube/Vimeo**
- Where: `storefront/snippets/f1genz-storefront.js:386-388,1732-1737,1761`; `src/review/public-review-input.ts:69-74`.
- Evidence: `normalizeVideoLink` chỉ kiểm `https://`. `sanitizePublicMedia` `continue` im lặng với host khác. `getVideoEmbedUrl` (`:394`) mới kiểm host nhưng không dùng để validate form.
- Scenario: Khách dán `https://example.com/clip.mp4`, thấy "Cảm ơn bạn", review lưu không có video.
- Fix: Validate bằng `getVideoEmbedUrl(rawVideoUrl)` trong `:1732` và báo "Link video phải là YouTube/Vimeo". Cân nhắc thêm `player.vimeo.com` vì server cho phép. Cập nhật `test/storefront.test.ts`.
- Found-by: E. Confidence: VERIFIED.

**V-17 [Low] [CODE+TEST] Chữ ký ticket có ký tự không ASCII biến 401 thành 500**
- Where: `src/media/media.service.ts:186` (HEAD `:118` giống hệt).
- Evidence: So `computed.length !== signature.length` bằng độ dài chuỗi UTF-16 nhưng `Buffer.from(...)` đo byte; `timingSafeEqual` ném `RangeError` khi byte lệch.
- Scenario: `POST /api/public/media/upload?ticket=<42 ASCII>%C3%A9` trả 500. Guard mới gọi hàm này trước khi đọc body.
- Fix: `const a = Buffer.from(computed), b = Buffer.from(signature); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw ...`. Thêm test với ký tự đa byte.
- Found-by: B. Confidence: VERIFIED.

**V-18 [Low] [CODE+TEST] Lần thử upload thất bại vẫn tiêu hao trần 500/ngày của store**
- Where: `src/media/media.service.ts:238-241` (`recordDailyUpload` trong `verifyUploadTicket`), `:340-391` (`uploadFile` chạy sau).
- Evidence: Nonce và bộ đếm bị tiêu thụ trước sniff và PUT lên Worker.
- Scenario: Một client mint ticket rồi up file rác, tốn khoảng 50 phút để cạn trần của store nạn nhân; kết hợp V-7 thì nhanh hơn.
- Fix: Chuyển `recordDailyUpload` sang sau khi Worker PUT thành công; giữ kiểm tra ở guard. Cần sửa `test/s5-media-infra.test.ts:142-156` (đang đếm qua `verifyUploadTicket`). Tùy chọn.
- Found-by: A. Confidence: VERIFIED.

**V-19 [Low] [CODE] Mint ticket không kiểm tra `storageConfigured`**
- Where: `src/media/media.service.ts:153-170`; `docs/env-contract.md:78` (nói "upload tickets cannot be issued" khi thiếu).
- Evidence: Chỉ `ticketSecret()` được kiểm; thiếu `R2_WORKER_URL`/`R2_PUBLIC_DOMAIN` thì `uploadFile` mới trả 503 sau khi ticket và slot ngày đã bị tiêu.
- Fix: Đầu `createUploadTicket`: `if (!this.storageConfigured) throw uploadUnavailable(UPLOAD_ERROR.notConfigured, 'Media upload is not configured')`. Test hiện tại đều dựng env đủ ba biến.
- Found-by: A. Confidence: VERIFIED.

**V-20 [Low] [CODE+TEST] Q&A public không kiểm tra sản phẩm tồn tại (khác review)**
- Where: `src/qna/qna.service.ts:367-376` (`submitPublicQuestion`); đối chiếu `src/review/review.service.ts:~673`.
- Evidence: Chỉ kiểm install đang serving rồi `upsertQuestion` (HEAD cũng không kiểm).
- Fix: Tùy chọn. Inject `CatalogProductStoreService` vào `QnaService`, ném `404 product_not_found` như review, và seed catalog cho các case e2e Q&A.
- Found-by: B. Confidence: VERIFIED (có từ HEAD).

**V-21 [Low] [CODE+TEST] `catalogLabels` nuốt lỗi DB nên `degraded` của dashboard không bao giờ báo**
- Where: `src/catalog/product-label.ts:75-78`; `src/dashboard/dashboard.service.ts:~116,~292`.
- Evidence: `.catch(() => [])` trong `catalogLabels` nằm dưới `runSection`.
- Fix: Cho `catalogLabels` ném lỗi, hoặc bọc riêng ở dashboard. Cẩn thận: `catalogTitles` còn phục vụ danh sách review/Q&A, nên kiểm tra tác động trước. Tùy chọn.
- Found-by: A. Confidence: VERIFIED.

**V-22 [Low] [CODE] `purchase.getAudit` quét distinct không giới hạn; transaction dùng timeout mặc định 5 giây**
- Where: `src/purchase/purchase-store.service.ts:231-236` (`findMany({ distinct: ['orderId'] })`), `:370-424` (không truyền `timeout`/`maxWait`). Gọi từ `src/ops/ops.service.ts:63`.
- Evidence: Bảng này chỉ có dữ liệu từ khi patch này nối `orders/*` vào đồng bộ (HEAD không ghi bảng).
- Fix: Dùng `$queryRaw` với `COUNT(DISTINCT order_id)`. Phần timeout (D-R8, SUSPECTED) chỉ cần nếu đo thấy P2028; chưa nên thêm hằng số khi chưa có số đo.
- Found-by: D. Confidence: VERIFIED (đường code); chưa xác nhận kế hoạch Prisma.

**V-23 [Low] [CODE+TEST] `WEBHOOK_RATE_LIMIT_*` bắt buộc ở production nhưng không có code nào đọc**
- Where: `src/config/env.schema.ts:45-46,255-267,373-374,396-397`; `.env.example:58-59`; `docs/env-contract.md:89-90`; `docs/deploy-sapo.md:131`; `test/lifecycle.test.ts:73-74`; `e2e/http-contract.cjs:155-156`.
- Evidence: `plans/reports/problem-solving-winner-D.md:152` đã yêu cầu "remove it from the required list or wire it"; patch chỉ viết docs thừa nhận biến chết.
- Fix: Xóa field, parse, hai danh sách required, dòng example, hai hàng docs và fixture test/e2e. Có nhiều file, nên grep lại toàn repo trước khi xóa.
- Found-by: A, C. Confidence: VERIFIED.

**V-24 [Low] [CODE] Code chết và `BUILD_SHA` không được nối**
- Where: `src/database/metafield-sync-pending.service.ts:92-98` (`countDue`, `countAll` không có caller); `.github/workflows/deploy.yml` (ghi `DEPLOY_COMMIT` nhưng không có gì đọc); `src/health/health.controller.ts:76` luôn báo `"local"`.
- Fix: Xóa hai method. Trước `pm2 startOrReload` đặt `BUILD_SHA="$(cat DEPLOY_COMMIT)"` (`--env-file` của Node không đè biến môi trường có sẵn).
- Found-by: D. Confidence: VERIFIED.

**V-25 [Low] [CODE] Workflow: deploy chạy được từ mọi ref khi `workflow_dispatch`; E2E chạy hai lần mỗi lần push `master`**
- Where: `.github/workflows/deploy.yml` (`on.workflow_dispatch`, job `deploy`, không có `if`); `.github/workflows/ci-e2e.yml:3-9` (`push.branches` gồm `master`) kết hợp `deploy.yml` job `e2e` gọi lại chính file đó.
- Evidence: Docs `docs/deploy-sapo.md` ghi ci-e2e chạy khi push `main`, không phải `master`.
- Fix: Thêm `if: github.ref == 'refs/heads/master'` cho job `deploy`. Bỏ `master` khỏi `push.branches` của `ci-e2e.yml`.
- Found-by: A, B, C, D. Confidence: VERIFIED.

**V-26 [Low] [CODE] Vi phạm quy tắc "không comment": JSDoc, banner và comment mô tả WHAT trong file mới**
- Where, xóa (src): `src/common/security/body-limits.ts:26-31`; `http-hardening.ts:14-18`; `public-response.ts:29-32,68`; `security-headers.ts:9,30-36`; `src/database/install-metadata.ts:3-8`; `src/storefront/storefront-asset-cache.ts:1-5`; `src/storefront/storefront.service.ts:15-16,23-24`; `src/health/health-verdict.ts:9`; `ecosystem.config.cjs:1-3,11`.
- Where, xóa (client/storefront): `client/src/common/AuthService.js:4-9,26` (rút còn một dòng về hmac); `authBootstrap.js:13-16,27-28,31,51`; `authFlow.js:24,44,66-67,77-79,87`; `pages/auth/login/index.jsx:83-84`; `pages/dev/index.jsx:31-33`; `config/AxiosConfig.js:22,44-45,56`; `client/functions/api/[[path]].js:1-4,10,19,22,26,29`; `storefront/snippets/f1genz-storefront.css:1053-1054,1072`; JSDoc/banner trong `e2e/lib/*.cjs`, `client/e2e/{run,lib/harness,storefront-widget,journeys}.cjs`; banner `// ----`/`// ====` trong `test/durability.test.ts`, `test/security.test.ts`, `e2e/http-contract.cjs`.
- Giữ (bất biến an toàn, đã kiểm): `public-rate-limit.ts:16`, `media.service.ts:62,178,236`, `public-media.guard.ts:26`, `catalog-sync.service.ts:133`, `catalog-product-store.service.ts:350`, `durability-sweep.service.ts:138,198`, `webhook.service.ts:146,346`, `install-revocation.ts:35`, `oauth-state.service.ts:38`, `metafield-sync-pending.service.ts:22`. B liệt kê `public-rate-limit.ts:16`, `media.service.ts:62` và `public-media.guard.ts:26` là vi phạm; đó là bất biến an toàn nên bị loại khỏi findings.
- Không động vào: `ProductSearch.jsx:23-26,91,94,104` (file không nằm trong diff, có sẵn từ HEAD), banner trong `client/src/index.css` và `pages/settings/index.jsx`.
- Found-by: A, B, C, D, E. Confidence: VERIFIED.

**V-27 [Low] [DOCS] Tài liệu mâu thuẫn với code**
- Where: `README.md:22`, `docs/getting-started-sapo.md:35-37`, `docs/env-contract.md:3`, `docs/anti-patterns.md:90`, `ecosystem.config.cjs:2-3` nói server không đọc `.env`; `src/config/app-config.module.ts:31-33,42` (không đổi so với HEAD) gọi `loadLocalEnv()` đọc `./.env` và `./server/.env` mỗi lần boot, và `e2e/lib/infra.cjs:146-147` cũng nói vậy.
- Thêm: `docs/getting-started-sapo.md:52` ("example key in `.env.example` is for local use only") không còn đúng vì file chứa placeholder; `:5` ghi "VPS deploy use Node 22" trong khi workflow không cài Node trên VPS và `deploy-sapo.md` ghi 20.6+; `docs/deploy-sapo.md:8` ghi `/storefront/* → proxy` trong khi `client/public/_routes.json` chỉ có `/api/*` và asset được phục vụ từ host API.
- Fix: Sửa tài liệu theo code (giữ loader, vì e2e dựa vào nó), xóa hoặc viết lại mục anti-pattern sai, bỏ lối đi `server/.env` nếu muốn dọn.
- Found-by: C. Confidence: VERIFIED.

**V-28 [Low] [CODE+TEST] Một số test không thể fail với hồi quy mà tên test nêu**
- Where, đã dò: `test/storefront.test.ts:449-456` (`loadRuntime()` không có `Image`, `loadImageElement` reject rồi `prepareImageForUpload` trả file vì `size <= IMAGE_MAX_SIZE`; xóa early-return ở `f1genz-storefront.js:782-783` vẫn xanh); `test/security.test.ts:700-701` (`peeked.nonce.length > 0` luôn đúng vì `inspectUploadTicket` không chạm Redis, nên không phát hiện `PublicMediaGuard` gọi nhầm `verifyUploadTicket`); `test/lifecycle.test.ts:314-336` (hai `handle` chạy tuần tự, stub `findUnique` cố định, không đếm số lần handler chạy; chỉ `durability.test.ts:207` là race thật); `client/e2e/journeys.cjs:~437-449` (N1 `.catch(() => undefined)` trên tiêu đề, regex `/…|3/` khớp mọi chữ số 3); `client/e2e/storefront-widget.cjs:~192` (`open()` nuốt `waitForSelector`); `e2e/http-contract.cjs:453-456` (L5 gửi `store=` thay vì `storeDomain`, nhánh 200 không thể xảy ra).
- Chưa dò lại từng dòng: `test/durability.test.ts:357-370` (stub so với chính literal), R8 `hasSummary || hasScalars`, U1 `[401,403,409]`, H7, Q3, S3.
- Fix: Truyền factory `Image` có đếm và assert không được gọi; sau gate, `verifyUploadTicket` vẫn thành công đúng một lần; dùng `Promise.all` với `updatedAt` thật và đếm handler; bỏ `.catch` và thay regex N1 bằng giá trị seed cụ thể.
- Found-by: C, E. Confidence: VERIFIED (các mục đã dò), SUSPECTED (các mục chưa dò).

**V-29 [Low] [CODE] `routes.js` vẫn chuyển `dev` và `password` vào mọi link nội bộ**
- Where: `client/src/common/routes.js:16-22`.
- Evidence: `["dev","password"].forEach(...)` chép query vào `withStoreDomain`. `DevGate` đã bị xóa; `grep` còn lại chỉ thấy `BuildInfo.js` (`"dev"`) và `ErrorReporter.js` (`password` trong regex nhạy cảm).
- Fix: Xóa vòng `forEach`.
- Found-by: E. Confidence: VERIFIED.

---

### Đối chiếu bốn điểm được yêu cầu chú ý
- (a) Trường thời gian đơn hàng: tài liệu Sapo dùng `modified_on`; repo không có chứng cứ đo thật; code và fixture dùng `updated_on` (V-1).
- (b) Baseline migration: `202607050000_init` là file mới, không có lịch sử git; migration duy nhất từng commit giả định bảng đã có. Có `[LIVE]`: DB production có bảng chưa (V-5).
- (c) Bucket đọc công khai: `public-rate-limit.ts` và test `security.test.ts:289-308` xác nhận thiết kế cố ý, nhưng cap 600 thấp hơn cap client 900 nên hậu quả là DoS (V-2).
- (d) Ba quy tắc repo: có vi phạm quy tắc comment ở V-26. `prefers-reduced-motion` chỉ xuất hiện trong test cấm nó (`client/e2e/storefront-widget.cjs:223`), không vi phạm. Hardcoded fallback: không có vi phạm mới. Default `localhost` ở `env.schema.ts:188-189` giống HEAD (`:211-212`) và production bắt buộc đặt tường minh; fallback URL cứng ở Pages Function đã được gỡ. Không thấy `: any` trong `src`.

## Receipt
`ultra: union=29/48; single_candidate_only=22`

Không finding nào bị loại hoàn toàn. Hai finding bị hạ mức: B-R2 (Medium xuống Low) và D-R4 (Medium xuống Low). Một số phần con bị gạch: B-R8 về comment an toàn, D-R8 vì chưa đo, C-R5/R6 phần chưa dò lại.

## Fix order
Chia theo chủ sở hữu file để chạy song song, không chồng file. Làm lượt 1 trước, các lượt còn lại độc lập.

1. **Owner PURCHASE/CATALOG/DB** (V-1, V-8, V-9, V-13, V-14, V-22, V-24 phần xóa method): `src/purchase/purchase-store.service.ts`, `src/sapo/webhook.service.ts`, `src/sapo/uninstall.service.ts`, `src/catalog/catalog-sync.service.ts`, `src/catalog/catalog-product-store.service.ts`, `src/database/metafield-sync-pending.service.ts`, `prisma/schema.prisma` + migration mới, `test/s3-privacy-webhooks.test.ts`, `test/durability.test.ts`.
   - V-1 làm đầu tiên; V-9 phải sinh SQL bằng `prisma migrate diff`.
2. **Owner PUBLIC-API/MEDIA** (V-2, V-3, V-7, V-10, V-11, V-17, V-18, V-19, V-20, V-21): `src/common/security/*`, `src/media/*`, `src/review/*`, `src/qna/*`, `src/ops/durability-sweep.service.ts`, `src/catalog/product-label.ts`, `src/dashboard/dashboard.service.ts`, `test/security.test.ts`, `test/s5-media-infra.test.ts`, `test/w2-media-deletion.test.ts`, `test/review-public-gates.test.ts`.
   - V-2, V-3a, V-17, V-19, V-10 áp thẳng được. V-3b, V-18, V-20, V-21 cần chỉnh test đi kèm.
3. **Owner CONFIG/CI/DOCS** (V-4, V-5, V-23, V-25, V-27, V-24 phần `BUILD_SHA`): `src/config/env.schema.ts`, `.env.example`, `docs/**`, `README.md`, `ecosystem.config.cjs`, `.github/workflows/*`, `test/lifecycle.test.ts`, `e2e/http-contract.cjs`, `e2e/lib/*`.
   - V-4 phải đi cùng bump secret e2e; V-5 và V-27 là docs thuần.
4. **Owner CLIENT/STOREFRONT** (V-6, V-12, V-15, V-16, V-29, V-28 phần client): `client/src/**`, `client/functions/api/[[path]].js`, `client/e2e/**`, `storefront/snippets/*`, `test/storefront.test.ts`.
   - V-6, V-12, V-29 áp thẳng được; V-15 cần DOM theme thật; V-16 kèm test.
5. **V-26** (comment): mỗi owner xóa phần comment thuộc file của mình trong lượt của họ. Không có lượt riêng để tránh chồng file.
6. **V-28** (test yếu): xử lý cùng owner của từng file test (`test/security.test.ts` thuộc owner 2, `test/lifecycle.test.ts` thuộc owner 3, `test/storefront.test.ts` và `client/e2e/**` thuộc owner 4).

Việc để lại, không áp mù: V-5 (cần biết DB production), V-7 (cần biết origin có nhận IPv6), V-15 (cần DOM theme), V-13, V-14, V-18, V-20, V-21, V-22 (tùy chọn).

Status: DONE_WITH_CONCERNS
Summary: Hợp nhất 48 finding thành 29, không có Critical. Hai High: V-1 (guard thứ tự đơn hàng đọc sai tên trường `modified_on`) và V-2 (bucket đọc 600/phút thấp hơn cap client 900/phút nên DoS được cả store). Tôi chỉ đọc, không sửa, build hay chạy gì; V-1 xác nhận bằng tài liệu Sapo chính thức, chưa đo payload webhook thật.