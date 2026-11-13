# Brownfield testbeds (FR-1.2)

Vendored external projects used as **brownfield** benches: the AIDLC workflow
*modifies* this existing code rather than building from scratch, then is scored
against each project's OWN third-party contract. Task specs live in
`../_brownfield-task-defs/`.

## httpbin/ — BUGFIX task

- **Upstream**: `psf/httpbin` (the maintained fork; `postmanlabs/httpbin` is
  dead since 2018 and does not import on Python 3.13). Commit pinned in
  `httpbin/UPSTREAM_COMMIT`.
- **License**: ISC / MIT (dual, permissive) — see `seed/LICENSE.*`.
- **Stack**: Flask / WSGI. Boots via the contract runner's Flask path
  (`gunicorn httpbin.core:app`). No DB.
- **Seed = pristine.** The `/base64` bug (bare `except:` returning HTTP 200 on
  malformed input) is ALREADY LATENT upstream — no delta needed. The fix must
  make malformed input return 400.
- **Scored by**: explicit HTTP assertions (see the bugfix task def) — valid
  input → 200, malformed → 400 ×2.

## realworld/ — FEATURE task

- **Upstream**: `c4ffein/realworld-django-ninja` (RealWorld reference impl for
  Django Ninja). Commit pinned in `realworld/UPSTREAM_COMMIT`.
- **License**: MIT — see `seed/LICENSE`.
- **Stack**: Django 5.2 + django-ninja, SQLite. Boots via the contract runner's
  Django path (`manage.py migrate` → `runserver`, DEBUG=True, DATABASE_URL unset
  so its settings pick file SQLite).
- **Seed = follow/unfollow REMOVED.** The two routes
  (`POST`/`DELETE /profiles/{username}/follow`) were deleted from
  `seed/apps/accounts/api.py` to create the "unimplemented feature" state; the
  removed handlers are stashed in `realworld/REMOVED-follow-routes.reference.py`
  as the golden reference. The `following` field + follower model are left
  intact, so the model has the supporting structure to build on.
- **Scored by**: the RealWorld project's own Hurl suite in
  `realworld/contract-hurl/` (from `realworld-apps/realworld` specs/api/hurl).
  The `profiles.hurl` file exercises follow/unfollow; the full suite is the
  no-regression gate. VERIFIED: passes on pristine, fails with follow removed.

## Excluded from the seeds (not needed for the API bench)

- `.git`, `.venv`, caches, `__pycache__`.
- RealWorld `fronts/` (Vue/React submodule frontends) and `realworld/` (the spec
  submodule — its hurl files are vendored under `contract-hurl/` instead).

## Refreshing a testbed

Re-clone the pinned commit, rsync into `seed/` with the same excludes, re-apply
the seed delta (httpbin: none; realworld: re-remove follow/unfollow), and
re-run the smoke to confirm boot+score still work.
