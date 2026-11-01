> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 19. Signing out of the office  — built 2026-10-14 (owner asked for a way out), details GUESSED

The owner, 2026-10-14: there was no way to log out. The header's avatar and name now open an account menu
(name, email, role, **Log out**); on a phone, Log out sits at the foot of "More".

| Question | What the code does | Why |
|---|---|---|
| Does signing out end the session on the server? | **Yes, since 2026-10-17 (§23):** `POST /auth/logout` revokes the sign-in's refresh token and every token refreshed from it. The access token is a signed JWT that cannot be taken back; it lapses within the hour. (Until 2026-10-17: no — tokens were stateless and nothing was revoked.) | §23. |
| What the browser forgets | The token and user, every cached query (`queryClient.clear()`), and the unsaved cycle-wizard draft — **GUESS:** the draft is the person's who typed it, and the next partner on the browser should not be offered it as theirs. A partner who signs out mid-wizard loses that draft. | Rule from the owner: logout clears cached data (LEARNINGS). |
| Alerts on this browser | **GUESS:** the browser's push subscription is removed (API row deleted, then the browser unsubscribes) while the token is still there to authorise it. Best effort, given two seconds; it never keeps anyone signed in. The partner turns alerts on again from Settings after the next sign-in. | Subscriptions are stored per user, so without this the next person on the browser would keep receiving the last one's notifications. |
| Where it lands | The login page of the language being read (`/{locale}/login`), replacing the history entry. Back shows nothing of the office: a signed-out shell draws nothing while it redirects, and a page restored from the back/forward cache re-reads storage. | It used to be hard-coded to `/en/login`. |
| Another tab of the same browser | Signs out with it (the `storage` event): its cache is cleared and it goes to the login page. | One browser, one person. |

