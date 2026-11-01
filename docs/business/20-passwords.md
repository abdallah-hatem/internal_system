> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 20. Passwords  — DECIDED 2026-10-14 (owner hit "change my password" failing), details GUESSED

The owner, 2026-10-14: changing the password in Settings never worked. The form sent `currentPassword` and the API
read `oldPassword`, so every change failed with a server error, shown as a generic "error"; the form had already
emptied itself before the answer came; a confirmation that did not match did nothing, silently; and nothing stopped
a one-character password.

| Question | Rule | Status |
|---|---|---|
| What a password must be | At least **8 characters, with at least one letter and one digit**. Letters and digits of any script count (Arabic included); spaces count as characters. No symbol or capital required. Refused as `PASSWORD_TOO_WEAK`. | **GUESS** (recommended option, taken without asking): long enough to stop the trivial, short enough that partners do not write it down. The demo seed's `password123` passes. |
| Where it applies | Every place a password is **set**: change password, a partner creating a user (`/auth/register`, `/users`), a shop signing up on the storefront, and `scripts/prod-reset-partners.sh`. One definition, `apps/api/src/common/password-rule.ts`; the office form and storefront carry copies that say so, the office copy pinned by a unit test. | DECIDED |
| Signing in with an older, weaker password | Still works. The rule applies the next time the password is set, not at the door. | **GUESS** — refusing would lock out anyone set up before the rule. |
| New password equal to the current one | Refused, `PASSWORD_SAME_AS_CURRENT`. Only this one is compared; there is no history of older passwords. | DECIDED (owner's brief) |
| Wrong current password | Refused, `WRONG_CURRENT_PASSWORD`, shown in the reader's language through `useApiError()` — checked in Arabic by 99-change-password TC-PW-03. Nothing is changed. | DECIDED |
| Order of checks | The rule first (it needs nothing stored), then the current password, then "not the same". | DECIDED |
| Does changing it sign you out? | **This device stays signed in; every other device is signed out** (since 2026-10-17, §23). All of the person's refresh tokens are revoked and this device is handed a new one. Another device's access token still works until it lapses, within the hour. | **GUESS** (recommended), replacing the 2026-10-14 guess "the session is kept everywhere", which left a lost phone signed in. |
| The form | Fields are kept after any refusal and cleared only on success. A confirmation that differs says *"The two new passwords don't match"* under it and sends nothing. The rule is shown as a hint under the new password; placeholders are valid examples (`YourCurrentPassword1`, `StrongPassword@123`). | DECIDED |
| Unknown or missing fields | `VALIDATION_FAILED` (400), never a 500 — including the old `oldPassword` name, and any field naming a user: whose password it is comes from the token only. | DECIDED |

Open: bcrypt reads only the first 72 bytes of a password, so two passwords that share those are the same password.
The field allows 200 characters. Harmless at the lengths people type; recorded rather than enforced.

