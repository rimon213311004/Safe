# SafeCheck

Privacy-first personal safety, verification and incident reporting platform.

You can confirm something about an email address or phone number **you already
have**. You cannot browse people. A report becomes visible only after it has been
upheld on review, the person it concerns has been notified, and their appeal
window has closed with no appeal pending.

- **API** — Express 5 + Mongoose 9 + Zod 4, on Node 20+
- **Web** — Next.js 16 App Router, React 19, plain CSS (no Tailwind, no UI kit)
- **Contracts** — one Zod package both sides import, so a request shape cannot
  drift between client and server

---

## Table of contents

1. [Quick start](#quick-start)
2. [Repository structure](#repository-structure)
3. [Where to work — a task-to-file map](#where-to-work--a-task-to-file-map)
4. [How the parts fit together](#how-the-parts-fit-together)
5. [The four guarantees, and where each is enforced](#the-four-guarantees-and-where-each-is-enforced)
6. [API surface](#api-surface)
7. [Web routes](#web-routes)
8. [Email verification (the OTP code)](#email-verification-the-otp-code)
9. [Environment variables](#environment-variables)
10. [Scripts](#scripts)
11. [Tests](#tests)
12. [Design system](#design-system)
13. [Deploying](#deploying)

---

## Quick start

```bash
npm install
```

```bash
cp .env.example apps/api/.env
```

Fill in `apps/api/.env` — at minimum `MONGODB_URI` and the four secrets. Generate
each secret separately:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then build the contracts package once and start both apps:

```bash
npm run build:shared && npm run dev
```

- Web — <http://localhost:3000>
- API — <http://localhost:4000>

Optionally load demo data:

```bash
npm run seed
```

The seed prints every account it creates. The password for all of them is
`SafeCheck2026!`; the admin is `admin@safecheck.local`.

> **`npm run build:shared` is not optional.** `apps/api` and `apps/web` import
> `@safecheck/shared` from its compiled `dist/`. A stale or missing `dist/` shows
> up as dozens of phantom type errors in files you never touched.

---

## Repository structure

```
Safe/
├── package.json                  npm workspaces root; every script you run lives here
├── tsconfig.base.json            shared compiler options; per-package tsconfigs extend it
├── .env.example                  the shape of apps/api/.env, fully commented
├── .gitignore                    .env, /var/, dist/, .next/ — secrets and build output
│
├── packages/
│   └── shared/                   @safecheck/shared — the contract layer
│       ├── src/index.ts          the only public entry point; re-exports everything
│       ├── src/enums.ts          roles, report/case/appeal states, categories
│       └── src/schemas/
│           ├── common.ts         pagination, ids, the SEARCH_DISCLAIMER constant
│           ├── auth.ts           register / login / verify-email / OTP payloads
│           ├── report.ts         report create, update, submit, withdraw
│           ├── evidence.ts       upload metadata, MIME allow-list
│           ├── search.ts         the single lookup request + its response
│           ├── moderation.ts     queue filters, decisions, disclosure
│           ├── appeal.ts         appeal filing and resolution
│           └── notification.ts   notification list and read-marking
│
├── apps/
│   ├── api/                      @safecheck/api — the server
│   │   ├── src/index.ts          process entry: connect, listen, handle signals
│   │   ├── src/app.ts            builds the Express app and mounts every router
│   │   │
│   │   ├── src/config/
│   │   │   ├── env.ts            Zod-validated environment; REFUSES TO BOOT if wrong
│   │   │   └── cloudinary.ts     Cloudinary SDK configuration
│   │   │
│   │   ├── src/db/connection.ts  Mongoose connect/disconnect with retry
│   │   │
│   │   ├── src/domain/
│   │   │   ├── visibility.ts     ⭐ the one place that decides what is public
│   │   │   └── visibility.test.ts
│   │   │
│   │   ├── src/lib/
│   │   │   ├── crypto.ts         keyed identifier hashing, evidence encryption
│   │   │   ├── errors.ts         AppError and the typed error codes
│   │   │   └── logger.ts         pino, pretty in dev
│   │   │
│   │   ├── src/middleware/
│   │   │   ├── auth.ts           requireAuth / requireRole
│   │   │   ├── validate.ts       binds a Zod schema to body/query/params
│   │   │   ├── rate-limit.ts     per-route limiters (login, OTP, search)
│   │   │   └── error.ts          notFoundHandler + errorHandler
│   │   │
│   │   ├── src/models/           Mongoose schemas, one file per collection
│   │   │   ├── user.model.ts     accounts; identifiers stored as keyed hashes
│   │   │   ├── otp.model.ts      verification codes, hashed, TTL-expiring
│   │   │   ├── session.model.ts  refresh-token families for rotation/replay
│   │   │   ├── report.model.ts   the report and its lifecycle state
│   │   │   ├── evidence.model.ts encrypted-blob pointers + metadata
│   │   │   ├── moderation-case.model.ts
│   │   │   ├── decision.model.ts findings, and the separate publishable flag
│   │   │   ├── appeal.model.ts
│   │   │   ├── subject-profile.model.ts  the hashed subject of a report
│   │   │   ├── notification.model.ts
│   │   │   ├── audit-log.model.ts append-only record of moderator actions
│   │   │   └── index.ts          barrel export
│   │   │
│   │   ├── src/modules/          ⭐ one folder per feature: routes + service
│   │   │   ├── auth/             register, verify, login, refresh, logout, me
│   │   │   ├── reports/          draft → submit → withdraw, evidence, appeals
│   │   │   ├── evidence/         authorised streaming of decrypted evidence
│   │   │   ├── search/           the single identifier lookup
│   │   │   ├── moderation/       queue, assignment, notes, decisions
│   │   │   ├── appeals/          claiming and resolving appeals
│   │   │   └── notifications/    list and mark-read
│   │   │
│   │   ├── src/services/         cross-module concerns
│   │   │   ├── token.service.ts  access/refresh issuing and family rotation
│   │   │   ├── messaging.service.ts  ⭐ email + SMS transports (see below)
│   │   │   ├── media.service.ts  MIME sniffing, size limits, encryption
│   │   │   ├── subject.service.ts resolves an identifier to a hashed subject
│   │   │   └── audit.service.ts  writes the append-only audit log
│   │   │
│   │   ├── src/storage/          pluggable evidence storage
│   │   │   ├── types.ts          the StorageDriver interface
│   │   │   ├── cloudinary.ts     private raw assets
│   │   │   └── index.ts          driver selection from STORAGE_DRIVER
│   │   │
│   │   ├── src/queues/           BullMQ wiring (optional; needs REDIS_URL)
│   │   ├── src/scripts/          operational checks — see Scripts below
│   │   └── src/test/             Vitest + supertest + mongodb-memory-server
│   │
│   └── web/                      @safecheck/web — the client
│       ├── README.md             deeper notes on the client's design decisions
│       ├── next.config.ts        the same-origin /api → API_PROXY_TARGET rewrite
│       │
│       ├── app/layout.tsx        root layout, fonts, AuthProvider
│       ├── app/globals.css       ⭐ the entire design system, one file
│       ├── app/page.tsx          public landing page
│       ├── app/error.tsx         error boundary
│       ├── app/not-found.tsx     404
│       │
│       ├── app/(auth)/           unauthenticated screens
│       │   ├── layout.tsx        the narrow centred card frame
│       │   ├── login/page.tsx
│       │   ├── register/page.tsx
│       │   └── verify-email/page.tsx     where the OTP code is entered
│       │
│       ├── app/(app)/            authenticated screens
│       │   ├── layout.tsx        ⭐ sidebar / off-canvas drawer / app bar
│       │   ├── search/page.tsx           check an identifier
│       │   ├── reports/page.tsx          my reports
│       │   ├── reports/new/page.tsx      file a report
│       │   ├── reports/[id]/page.tsx     one report, evidence, appeal
│       │   ├── notifications/page.tsx
│       │   ├── settings/page.tsx         account and password
│       │   ├── moderation/page.tsx       case queue
│       │   ├── moderation/cases/[id]/page.tsx  review and decide
│       │   └── moderation/appeals/page.tsx
│       │
│       ├── components/ui.tsx      Field, Button, Badge, Loading, EmptyState…
│       └── lib/
│           ├── api.ts            ⭐ the only fetch wrapper; holds the access token
│           ├── api-types.ts      response types the API returns
│           ├── auth.tsx          AuthProvider, useAuth, useRequireAuth
│           ├── hooks.ts          useAsync and friends
│           └── labels.ts         enum → human-readable text, in one place
```

⭐ marks the files you will open most often.

---

## Where to work — a task-to-file map

| If you want to… | Start here |
| --- | --- |
| Add or change a request/response shape | `packages/shared/src/schemas/*` — then `npm run build:shared` |
| Add an API endpoint | `apps/api/src/modules/<feature>/*.routes.ts`, mount in `app.ts` if new |
| Change business rules | the matching `*.service.ts` — routes stay thin on purpose |
| Change what is publicly visible | `apps/api/src/domain/visibility.ts`, nowhere else |
| Add a database field | the model in `apps/api/src/models/`, plus the shared schema |
| Change email or SMS delivery | `apps/api/src/services/messaging.service.ts` |
| Change where evidence is stored | `apps/api/src/storage/` |
| Add an environment variable | `apps/api/src/config/env.ts` **and** `.env.example` |
| Change any colour, spacing, radius, shadow | the token block at the top of `apps/web/app/globals.css` |
| Change the sidebar, drawer or app bar | `apps/web/app/(app)/layout.tsx` + the nav section of `globals.css` |
| Add an authenticated screen | a folder under `apps/web/app/(app)/` |
| Call a new endpoint from the client | add a method to `apps/web/lib/api.ts` |
| Rename a status or category in the UI | `apps/web/lib/labels.ts` |

---

## How the parts fit together

### One source of truth for every payload

`packages/shared` exports Zod schemas. The API validates with them
(`middleware/validate.ts`); the web app infers its TypeScript types from the same
objects. A field renamed in one place fails to compile in the other, which is the
point.

### Routes are thin, services hold the rules

A `*.routes.ts` file does four things: attach middleware, validate input, call one
service function, shape the response. Every decision that could be wrong lives in
the service, where it is reachable from a test without an HTTP request.

### The access token never touches storage

`apps/web/lib/api.ts` holds the access token in a module-scoped variable — not
`localStorage`, not a readable cookie. The refresh token is an httpOnly cookie
(`sc_rt`) scoped to `/api/auth`. The cost is deliberate: **a page reload starts
with no token**, so the app calls `restoreSession()` on mount. That is why every
authenticated screen is a client component — a server render has no credential to
fetch with.

### Refresh is single-flight

Refreshing rotates the refresh-token family. Two concurrent refreshes present the
same token twice, which is indistinguishable from a stolen-token replay, so the
server revokes the whole family and signs the user out. `lib/api.ts` therefore
funnels every concurrent 401 into one in-flight refresh promise. **Do not add a
second refresh path.**

### Same-origin `/api`

`next.config.ts` rewrites `/api/*` to `API_PROXY_TARGET` (default
`http://localhost:4000`). The browser only ever talks to its own origin, so the
refresh cookie is first-party and no CORS preflight is involved.

---

## The four guarantees, and where each is enforced

| Guarantee | Enforced by |
| --- | --- |
| No browsing people — exact identifier only, no enumeration | `modules/search/search.service.ts` + rate limits in `middleware/rate-limit.ts` |
| Nothing under review is ever shown | `domain/visibility.ts` — a single predicate every read path calls |
| Deciding is not publishing — grave findings need a second moderator | `modules/moderation/moderation.service.ts`, the `publishable` flag on `decision.model.ts` |
| No readable directory of reported people | `lib/crypto.ts` — identifiers stored only as keyed hashes; evidence encrypted at rest |

`domain/visibility.ts` is the load-bearing file. It is small, it has its own test
file next to it, and no read path may re-implement its logic.

---

## API surface

All routes are prefixed `/api`. `auth` marks routes requiring an access token;
`mod` marks moderator-or-above.

### `/api/auth`

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/register` | create an account, send the verification code |
| POST | `/verify-email` | exchange the code for a verified account |
| POST | `/resend-otp` | send a fresh code (rate limited) |
| POST | `/login` | issue access + refresh tokens |
| POST | `/refresh` | rotate the refresh family, mint a new access token |
| POST | `/logout` | revoke the current session |
| GET | `/me` | the signed-in user — `auth` |
| POST | `/change-password` | `auth` |

### `/api/reports`

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/` | create a draft — `auth` |
| GET | `/` | my reports, paginated — `auth` |
| GET | `/:id` | one report — `auth` |
| PATCH | `/:id` | edit while still a draft — `auth` |
| POST | `/:id/submit` | submit for review; opens a moderation case — `auth` |
| POST | `/:id/withdraw` | withdraw — `auth` |
| POST | `/:id/evidence` | upload evidence (multipart) — `auth` |
| POST | `/:id/appeals` | file an appeal against a decision — `auth` |
| GET | `/:id/appeals` | appeals on this report — `auth` |

### The rest

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/evidence/:id/content` | stream decrypted evidence to an authorised viewer — `auth` |
| POST | `/api/search` | the single identifier lookup — `auth`, rate limited |
| GET | `/api/moderation/queue` | the case queue — `mod` |
| GET | `/api/moderation/cases/:id` | one case with its report and evidence — `mod` |
| POST | `/api/moderation/cases/:id/assign` | claim a case — `mod` |
| PATCH | `/api/moderation/cases/:id/state` | advance the case — `mod` |
| PATCH | `/api/moderation/cases/:id/priority` | `mod` |
| POST | `/api/moderation/cases/:id/notes` | internal note — `mod` |
| POST | `/api/moderation/cases/:id/decision` | record a finding — `mod` |
| PATCH | `/api/moderation/decisions/:id/publishable` | second-moderator clearance — `mod` |
| GET | `/api/moderation/decisions/:id/disclosure` | what the subject will be shown — `mod` |
| GET | `/api/appeals/pending` | unclaimed appeals — `mod` |
| GET | `/api/appeals/:id` | one appeal — `auth` |
| POST | `/api/appeals/:id/withdraw` | `auth` |
| POST | `/api/appeals/:id/claim` | a *different* moderator claims it — `mod` |
| POST | `/api/appeals/:id/resolve` | uphold or overturn — `mod` |
| GET | `/api/notifications` | list, with an unread count — `auth` |
| POST | `/api/notifications/read` | mark read — `auth` |

---

## Web routes

| Route | Screen |
| --- | --- |
| `/` | landing page — leads with what the product will not do |
| `/login`, `/register` | authentication |
| `/verify-email` | enter the six-digit code |
| `/search` | check an identifier |
| `/reports`, `/reports/new`, `/reports/[id]` | your reports |
| `/notifications` | notifications |
| `/settings` | account and password |
| `/moderation`, `/moderation/cases/[id]`, `/moderation/appeals` | moderator screens |

---

## Email verification (the OTP code)

Registration generates a six-digit code, stores **only its hash** with a TTL, and
hands it to the mail transport. Which transport runs is decided by one variable.

### `MAIL_DRIVER=console` (the default)

Nothing is emailed. The code is printed in the terminal running the API:

```
Mail (console driver)
  to: you@example.com
  subject: Verify your SafeCheck email
  Your verification code is 481920. It expires in 10 minutes.
```

This is why an inbox looks empty after signing up on a fresh checkout. Copy the
code from that terminal and paste it into `/verify-email`.

### `MAIL_DRIVER=smtp` — real delivery, free

Every provider worth using speaks SMTP, so one code path reaches all of them. Two
free options that need no credit card and no domain:

**Gmail** — about 500 messages a day. Turn on 2-Step Verification, then create a
16-character App Password at <https://myaccount.google.com/apppasswords>. Your
normal Google password will not work for SMTP.

```env
MAIL_DRIVER=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=abcdefghijklmnop
MAIL_FROM="SafeCheck <you@gmail.com>"
```

`MAIL_FROM` must be the same address as `SMTP_USER`; Gmail rewrites or rejects
anything else.

**Brevo** — 300 messages a day, free permanently. Sign up, open *SMTP & API →
SMTP*.

```env
MAIL_DRIVER=smtp
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=9xxxxx@smtp-brevo.com
SMTP_PASS=<the SMTP key, not your account password>
MAIL_FROM="SafeCheck <your-verified-sender@example.com>"
```

Restart the API, then prove it works before touching the sign-up form:

```bash
npm run mail:check -w @safecheck/api -- you@example.com
```

That sends one real message through whatever driver is configured and prints the
relay's reply — or the failure, with its underlying cause. Use it whenever a code
does not arrive: because codes are stored only as hashes, a broken transport is
otherwise invisible.

`SMTP_URL=smtps://user:pass@host:465` is also accepted and wins over the discrete
variables if both are set. Prefer the discrete ones — a URL has to
percent-encode its password, and a pasted password containing `@` or `/` produces
an authentication failure that looks nothing like an encoding bug.

### SMS

`SMS_DRIVER=console` prints instead of sending. There is no free tier for real SMS
anywhere; the Twilio transport is a stub. Phone verification is optional and email
alone is sufficient to use the platform.

---

## Environment variables

`apps/api/.env` is the file the API reads. `.env.example` at the repo root is its
fully commented template. `config/env.ts` validates all of it at boot and exits
with a readable message rather than starting half-configured.

| Variable | Notes |
| --- | --- |
| `NODE_ENV`, `PORT`, `WEB_ORIGIN` | `WEB_ORIGIN` must match the browser's origin exactly, or CORS and cookies fail |
| `MONGODB_URI` | Atlas or local; the database name is part of the URI |
| `REDIS_URL` | optional — only for BullMQ background jobs |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | 32 random bytes each, different values |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS` | `10m` / `30` |
| `IDENTIFIER_PEPPER` | the key that makes identifier hashes unguessable. **Changing it orphans every existing hash.** |
| `EVIDENCE_ENCRYPTION_KEY` | 32 random bytes. **Losing it makes stored evidence unreadable.** |
| `STORAGE_DRIVER` | `local` or `cloudinary` |
| `STORAGE_LOCAL_DIR` | `./var/evidence`, git-ignored |
| `CLOUDINARY_*` | evidence goes to private raw assets; avatars are public |
| `MAIL_DRIVER`, `MAIL_FROM`, `SMTP_*` | see above |
| `SMS_DRIVER`, `TWILIO_*` | `console` unless you have Twilio |
| `APPEAL_WINDOW_DAYS` | 14 — nothing is published while it is open |
| `EVIDENCE_RETENTION_DAYS` | 365 |

`apps/web/.env.local` is optional; copy `apps/web/.env.local.example` if you need
to point the proxy somewhere other than `localhost:4000`. Nothing secret belongs
in it — anything prefixed `NEXT_PUBLIC_` is compiled into the browser bundle.

**Never commit a real `.env`.** `.gitignore` already excludes `.env` and `.env.*`.

---

## Scripts

From the repository root:

| Command | What it does |
| --- | --- |
| `npm run dev` | API and web together, colour-tagged |
| `npm run dev:api` / `npm run dev:web` | one at a time |
| `npm run build:shared` | compile the contracts package — run this first |
| `npm run build` | shared, then API, then web |
| `npm run typecheck` | every workspace |
| `npm run test` | the API test suite |
| `npm run seed` | demo users, reports, cases, decisions |

Diagnostics, in `apps/api`:

| Command | What it checks |
| --- | --- |
| `npm run db:check -w @safecheck/api` | the Mongo connection and indexes |
| `npm run mail:check -w @safecheck/api -- you@example.com` | that email really sends |
| `npm run storage:check -w @safecheck/api` | round-trips a blob through the driver |
| `npm run storage:privacy-check -w @safecheck/api` | that stored evidence is **not** publicly fetchable |

There is no `npm run lint` in this repo. `npm run typecheck` is the check to run.

---

## Tests

```bash
npm run test
```

Vitest with `mongodb-memory-server`, so no external database is needed. Coverage
is concentrated where being wrong is expensive: `domain/visibility.test.ts` for
publication rules, `test/auth.test.ts` for token rotation and replay, and
`test/reports.test.ts` for the report lifecycle.

**Known state: 98 of 101 pass.** Three failures remain in
`src/test/moderation.test.ts`. They are a known, tracked gap rather than a
surprise, and they are not covering for a defect found in the visibility layer.

---

## Design system

`apps/web/app/globals.css` is the whole thing — no Tailwind, no component library,
no icon package. Icons are hand-written 20px SVG glyphs in
`app/(app)/layout.tsx`, because an icon dependency would be a megabyte for nine
paths.

Four rules give the interface its finish, and they are documented in the
stylesheet header:

1. Surfaces are gradients, never flat fills.
2. Raised surfaces carry a top-edge highlight — `inset 0 1px 0 var(--hairline)`.
3. Shadows are layered and ink-tinted; accent elements add an accent-tinted glow.
4. Every transition uses one easing curve, `--ease: cubic-bezier(0.32, 0.72, 0, 1)`.

Colour is reserved for status and for the navigation rail, so nothing competes
with the content.

### Responsiveness

Mobile-first and mostly breakpoint-free: sizes come from `clamp()` tokens rather
than from media queries. There are four real breakpoints:

| Breakpoint | What changes |
| --- | --- |
| ≤ 599px | list rows stack; definition lists become one column |
| ≤ 859px | the sidebar becomes an off-canvas drawer behind an app bar |
| ≥ 860px | the sidebar is a sticky column and the app bar disappears |
| ≥ 1440px | a wider nav rail and a capped content column |

Plus `@media (pointer: coarse)` for 44px touch targets and
`@media (max-height: 660px)` for phones in landscape.

Two traps worth knowing before editing this file:

- **`.shell` needs explicit `grid-template-rows`.** It is a grid with
  `min-height: 100dvh`; with two auto rows, leftover viewport height is
  distributed between them and a short page inflates the app bar to a third of the
  screen.
- **Never hand-write `-webkit-backdrop-filter`.** The production minifier
  (lightningcss) treats a prefixed/unprefixed pair as duplicates and keeps the
  last one — the prefixed form, which Chrome does not implement — so the blur
  silently disappears in the build. Write only the standard property; the
  minifier adds the prefixes its targets need.

### Drawer accessibility

The closed drawer is `visibility: hidden`, which takes it out of both the tab
order and the accessibility tree — so no focus trap and no `aria-hidden`
bookkeeping is needed. Visibility is switched instantly on the way in and only
*delayed* on the way out; transitioning it over the slide duration instead leaves
the drawer computing as hidden for the first frames, and `focus()` on a hidden
element is silently dropped.

---

## Deploying

- **API** — any Node 20+ host. `npm run build` then `npm start -w @safecheck/api`.
  Set every variable from the table above; `config/env.ts` will refuse to boot
  otherwise. Redis is optional.
- **Web** — `npm run build -w @safecheck/web`, then `npm start -w @safecheck/web`.
  Set `API_PROXY_TARGET` to the deployed API and `WEB_ORIGIN` on the API to the
  deployed web origin.
- Keep `IDENTIFIER_PEPPER` and `EVIDENCE_ENCRYPTION_KEY` backed up outside the
  host. Rotating either one without a migration is data loss.

---

SafeCheck is not an emergency service. If you are in immediate danger, contact
your local emergency number.
