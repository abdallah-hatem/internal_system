> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 23. Staying signed in to the office  — DECIDED 2026-10-17 (owner asked), details GUESSED

The owner, 2026-10-17, using the office as an app on his iPhone home screen: why does he have to log in every time
he opens it? The office's only token lasted 24 hours (`JWT_EXPIRATION`) and nothing renewed it, so opening the app a
day later signed him out.

| Question | Rule | Status |
|---|---|---|
| How long a sign-in lasts | **Until 30 days pass without opening the office.** Every time the app talks to the API after its access token has lapsed, it renews the sign-in, and the 30 days start again. Someone who opens it at least once a month never sees the login page. There is **no absolute limit** — a sign-in renewed every month lasts indefinitely. | DECIDED (owner's ask); 30 days and no absolute cap are **GUESS** (recommended) |
| How it works | Signing in gives two tokens. The **access token** (signed JWT, audience `internal`) lasts **1 hour** and goes with every request. The **refresh token** (256 random bits) is exchanged at `POST /auth/refresh` for a new pair. Only its SHA-256 hash is stored (`session_refresh_tokens`). | **GUESS** — 1 hour keeps a stolen access token short-lived; the refresh token is what lasts |
| Each refresh token works once | It is spent on use and replaced. A spent token presented again **more than 30 seconds** after it was spent means two holders (the app and whoever copied it), so **that whole sign-in ends on every device holding it** and both must sign in again. The same partner's other sign-ins (another device) are untouched. | DECIDED (security brief) |
| Reuse within 30 seconds | Treated as the same app racing itself (the page's requests, two tabs, the installed app and a tab): it gets its own new pair in the same sign-in, and nothing is ended — unless that sign-in was signed out meanwhile, which refuses it. | DECIDED — the owner's frontend rule (abdallah-skills building-frontends, "concurrent refreshes are normal", ≈30 s) |
| Several requests at once | Opening the app fires many requests; they share **one** refresh, within a tab and across tabs (a Web Lock). A tab that loses a race to another tab uses the winner's tokens. The 30-second window above covers whatever still gets through (a browser without Web Locks). | DECIDED |
| No signal | If the refresh cannot reach the API, the app **stays signed in** and the request fails as any offline request does; the next request tries again. Only the API refusing the refresh signs out. | **GUESS** |
| Signing out | `POST /auth/logout` revokes that sign-in (§19); the browser then forgets both tokens. Best effort, bounded at two seconds like the push release. | DECIDED |
| Changing your password | Ends every other sign-in; this device is given a new refresh token and stays signed in (§20). | **GUESS** (recommended) |
| Deactivating a user | Setting a user to INACTIVE or SUSPENDED revokes every sign-in they hold. Their access token is refused on the next request anyway (`JwtStrategy` re-reads the status). A refresh by someone no longer ACTIVE, or whose account became a shop's, is refused and ends all their sign-ins. | DECIDED (security brief) |
| A role changed after sign-in | The next refresh re-reads the user, so the new access token carries the current role and name; the office redraws with them. | DECIDED |
| Who it applies to | **The office only.** The assistant has its own OAuth refresh tokens (§16, `oauth_refresh_tokens`), which `/auth/refresh` does not accept; an assistant (MCP) access token is not a refresh token either. The storefront keeps its single `JWT_EXPIRATION` token (24h) and no refresh. | DECIDED for the office; storefront **OPEN** — the same could be done for shops if the owner wants it |
| Refusals | Every refused refresh is `SESSION_EXPIRED` (unknown, spent, revoked or expired token — a client only needs "sign in again"); a user no longer allowed in is `SESSION_INVALID`. | DECIDED |
| On release | Sessions signed in before the release have no refresh token: they end once more, when their current 24-hour token lapses, and last from the next sign-in on. Spent and expired rows stay in the table; nothing clears them yet. | **GUESS** — a periodic cleanup is cheap to add if the table grows |
