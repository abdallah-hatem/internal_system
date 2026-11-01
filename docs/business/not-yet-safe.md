> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## Not yet safe to run the business on

Recorded here so it is not forgotten. Rewritten 2026-10-08, when the old list
no longer described the system.

- **Partner logins still use the seeded demo password.** Production is live,
  and the partner accounts open with the password from the seed data, which
  sits in the public repository. The assistant (§16) can write to the business
  through those same logins. Each partner changes theirs before relying on it.
  (Until 2026-10-14 Settings → change password failed every time, so this
  could not be done from the app; it can now — §20.)
  Superseded 2026-10-14: the owner emptied production and replaced the partner
  logins (abdallah@ / shady@ / fares@) with passwords he typed, through
  `scripts/prod-reset-partners.sh`. The seeded password remains only in local and
  demo seeds.
- **Backups have never been tested.** The database's host keeps a short window
  for restoring to an earlier moment. Its length depends on the plan and has not
  been checked, no restore has ever been tried, and no copy is kept anywhere
  else.
- **No real cycle has been confirmed through it yet.** Two cycles exist in
  production. Whether they are the business's own or a trial run is not
  recorded, so no figure from them has been checked against reality.
  Superseded 2026-10-17/18: production holds one real cycle, CYC-2026-0001,
  entered mid-cycle after the fact (the test cycle CYC-2026-0002 was deleted);
  its ledger was checked by hand 2026-10-18 and agrees with itself. Some of its
  figures are still stand-ins until the owner sends the data listed in
  `docs/BUILD_LOG.md` "Waiting on the owner".

Fixed since the first version of this list: it runs in production now, not on
one laptop. Production has its own login-signing secret, and the system refuses
to start with a default or placeholder one.

---

