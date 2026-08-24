# @safecheck/web

The SafeCheck web client. Next.js App Router, React 19, TypeScript, and plain CSS.

```bash
npm install                 # from the repo root
npm run build:shared        # the contracts this app imports
npm run dev:web             # http://localhost:3000
```

The API must be running too (`npm run dev:api`, port 4000), or `npm run dev` from the
root for both.

## Why it is shaped this way

### The access token never leaves memory

`lib/api.ts` holds the access token in a module-scoped binding. Not localStorage,
not sessionStorage, not a readable cookie. Script injected into this origin can
therefore steal at most a ten-minute credential, and only while the tab is open.

The cost is real and paid deliberately: **a page reload starts with no token.** The
refresh token is an httpOnly cookie the browser will not show us, so the app calls
`restoreSession()` on mount and waits. That is why every authenticated screen is a
client component — a server render has no credential to fetch with and would
produce an empty shell.

### Refresh is single-flight

Refreshing rotates the token family. Two concurrent refreshes present the same
token twice, the API correctly reads that as replay, and it revokes the family — so
a dashboard that fired four requests on mount would sign the user out by loading.
`refreshInFlight` makes every caller share one attempt. Do not remove it.

### Requests go through a same-origin proxy

`next.config.ts` rewrites `/api/:path*` to the API. Three things fall out of that:
the refresh cookie is first-party, there are no CORS preflights, and the cookie's
`/api/auth` path scope on the API lines up exactly with what the browser sends.
Set `NEXT_PUBLIC_API_BASE_URL` to bypass the proxy and talk to the API directly;
`API_PROXY_TARGET` changes where the proxy points.

### Forms validate with the server's own schemas

Every form calls `validate(...)` from `lib/hooks.ts` with a schema out of
`@safecheck/shared` — the same object the API validates with. This is not
belt-and-braces: the API's 422 forwards `fieldErrors` only, so a rule that lives at
the object root (`subjectIdentifierInput` needs an email *or* a phone;
`searchInput` needs exactly one) would otherwise reach the user as "some fields
need your attention". Checking locally is what turns those into a sentence.

There is no form library. The validation contract already existed; all that was
missing was somewhere to put the result.

## What the UI is careful about

These are not stylistic choices — each one mirrors a guarantee the API makes, and
changing the wording can break it.

**An empty search result says nothing about the person.** The API returns a
byte-identical response for "we have never heard of this identifier" and "we hold
reports about them that are not disclosable". `app/(app)/search/page.tsx` must word
both the same way. Wording them differently would leak the exact fact the identical
response exists to hide.

**Months are never parsed as dates.** Search results carry `YYYY-MM` precision.
`formatMonth` in `lib/labels.ts` formats from the string's parts, because parsing
"2025-11" yields a timestamp, and a timestamp shifted into the reader's timezone
can land in October — a day the API withheld and a month it never said.

**Deciding is not publishing.** Two separate endpoints, two separate panels on the
case page, and the publication panel shows the disclosure gate's *live verdict*
next to the `publishable` flag. They disagree routinely: a cleared record with a
pending appeal discloses nothing. A moderator shown only the flag will believe they
published something they did not.

**Evidence is fetched as a blob, never linked.** `GET /evidence/:id/content` needs
a bearer token and answers with `Content-Disposition: attachment` plus a locked CSP,
specifically so the bytes can never render in this origin. An `<a href>` or an
`<img src>` would send no token and defeat the header. `api.evidenceBlob()` fetches
it and hands the browser a short-lived object URL.

**Outcomes are explained, not just labelled.** "Not upheld" is not a finding of
innocence and "insufficient evidence" is not a finding that nothing happened. The
parties read their own outcome here, so `outcomeMeaning` states what it does and
does not assert rather than leaving them to infer it.

**The subject label is a label.** `caseDetail.report.subjectLabel` is never an
identifier or a hash, and the case page says so on the page — otherwise a moderator
will assume the platform could produce a list of reported people. It cannot.

## Layout

```
app/
  layout.tsx              root shell; robots noindex, AuthProvider
  page.tsx                public landing
  (auth)/                 register · verify-email · login
  (app)/                  authenticated shell (sidebar, unread badge, role nav)
    search/               one exact identifier, no name search
    reports/              list · new · [id] (edit, submit, evidence, appeal, withdraw)
    notifications/        paged, explicit mark-read
    settings/             account, password change
    moderation/           queue · cases/[id] · appeals
lib/
  api.ts                  the only fetch in the app
  api-types.ts            response shapes, incl. the API's supersets of the contract
  auth.tsx                session restore, role gate
  hooks.ts                validate · useAction · useLoader
  labels.ts               enum wording, date/month/size formatters
components/ui.tsx         presentational primitives
app/globals.css           the whole design system, tokens and dark mode included
```

## Checks

```bash
npm run build:shared && npm run typecheck
```

`build:shared` first, always. A stale `packages/shared/dist` produces phantom type
errors in both apps and sends you chasing something that is not there.
