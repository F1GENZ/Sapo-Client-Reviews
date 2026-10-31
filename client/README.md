# F1GENZ Review for Sapo - admin SPA

React 19 + Vite + Ant Design 5 + TanStack Query. It is the merchant admin embedded in the Sapo admin and talks only to the NestJS API in the repo root (`/api/admin/*`, `/api/app/session`, `/api/auth/*`, `/api/oauth/install/*`).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on `:5173`; `/api` is proxied to `VITE_SAPO_API_URL` (default `http://localhost:3000`) |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve `dist/` |
| `npm run test:unit` | Auth storage contract test (`tests/auth-storage.contract.test.mjs`, `node --test`) |
| `npm run test:e2e` | Playwright admin journeys against `vite preview` with the API stubbed (`e2e/run.cjs`) |
| `npm run budget` | Bundle size budget check (run after `build`) |

## Auth model

- The session JWT is issued by the server after the Sapo launch or OAuth handoff. The SPA keeps it in `localStorage` and `sessionStorage`, scoped per `storeDomain`, and sends it as `Authorization: Bearer ...` together with `x-store-domain`.
- The SPA never writes a JavaScript-readable cookie. The server sets its own HttpOnly session cookie.
- Sapo access tokens never reach the browser.

## Routes

`/` dashboard, `/reviews`, `/qna`, `/settings`, `/guide`, `/dev`, `/contact`, `/health` (also `/ops`), `/install/login`. Every route except `/install/*` and `/oauth/*` requires a verified session for the `storeDomain` in the URL.

## Product links

Sapo product URLs are `https://{storeDomain}/{alias}`; `src/common/storeUrl.js` is the single builder used by the Reviews and Q&A pages.
