# Brownfield task definition — FEATURE: RealWorld follow/unfollow

> Authoritative spec for the `feature` task type (FR-1.2). Same structure as the
> bugfix def: testbed, seeded delta, task prompt, objective oracle, harness needs.

## Testbed

- **Repo**: `c4ffein/realworld-django-ninja` (the accepted RealWorld reference
  impl for Django Ninja).
- **Commit**: `04ef47c` (2026-05-05).
- **License**: MIT (permissive — vendorable).
- **Stack**: Django 5.2 + django-ninja (FastAPI-style typed API over Django).
  ~1.5K LOC first-party, 3 apps (accounts, articles, comments).
- **Contract**: the RealWorld project's own **frozen `openapi.yml` + Hurl suite**
  (14 files) — a THIRD-PARTY-authored standardized spec, not one we wrote. This
  is the key rigor win over sci-calc.
- **Boot (verified on 3.13 + SQLite)**: `pip install django==5.2.1
  django-ninja==1.4.1 django-cors-headers django-extensions markdown
  email-validator pydantic sqlparse jwtninja psycopg2-binary`; env
  `DEBUG=True DATABASE_URL=:memory: DJANGO_SETTINGS_MODULE=config.settings`;
  `manage.py migrate` then `manage.py runserver`. `/api/tags`, `/api/articles`
  → 200. GOTCHA: `helpers/exceptions.py` imports `psycopg2` unconditionally even
  on SQLite, so `psycopg2-binary` must be installed regardless of DB.

## Seeded starting state (author-controlled delta)

The impl is COMPLETE against the spec — follow/unfollow IS implemented
(`apps/accounts/api.py:92-108`, `follow_profile` / `unfollow_profile`). So we
create the "unimplemented feature" state by DELETING those two routes from the
seed copy:

- Remove the `@router.post("/profiles/{username}/follow", ...)` handler
  (`follow_profile`, lines ~92-104).
- Remove the `@router.delete("/profiles/{username}/follow", ...)` handler
  (`unfollow_profile`, lines ~105-118).
- Leave `GET /profiles/{username}` and the `following` field plumbing intact
  (the models/schemas already support it — this is purely the two missing routes).

Result: `POST`/`DELETE /profiles/{username}/follow` return 404 (route absent),
exactly as an unimplemented feature would. The `following` boolean on profile
responses stays wired, so the model has the supporting structure to build on —
a realistic "add the endpoints" feature, not a from-scratch subsystem.

Keep the removed handlers stashed as the reference implementation for the golden.

## Task prompt (given to the model)

> The RealWorld API spec defines two profile endpoints that are missing from this
> codebase:
> - `POST /profiles/{username}/follow` — authenticated; the current user follows
>   `{username}`; returns 200 with the target's Profile and `following: true`.
> - `DELETE /profiles/{username}/follow` — authenticated; unfollows; returns 200
>   with the target's Profile and `following: false`.
> Both return 404 if `{username}` doesn't exist and 401 if unauthenticated.
> The `Profile` schema and the `following` field already exist; the follower
> relationship is modeled. Implement both endpoints per the RealWorld spec.

## Scoring oracle (Hurl suite path)

The RealWorld spec repo (git submodule `realworld/` in the impl, or fetched from
`realworld-apps/realworld`) ships `api/*.hurl`. The relevant file is the
**profiles** suite (follow/unfollow cases). Scoring:

- Run the profiles Hurl file(s) against the booted server:
  `HOST=http://localhost:<port>/api hurl --test api/profiles.hurl` (or the
  repo's `run-api-tests-hurl.sh`).
- Pass = the follow/unfollow assertions flip from failing (404, route absent) to
  passing. Existing suites (auth, articles, comments, tags) must stay green — the
  full suite is the regression gate.
- Secondary gate: the impl's own `make test-django` unit suite still passes.

## Harness needs (scopes #11)

- **Boot**: Django app via `manage.py runserver` (not uvicorn/ASGI discovery),
  with the SQLite/DEBUG env above and a `migrate` step first.
- **Scoring**: a **Hurl-suite runner** — invoke `hurl` against the booted server,
  parse pass/fail per assertion. Requires the `hurl` binary in the sandbox image
  (verify/add it). This is the main new capability the contract runner needs.
- Swagger-2.0 parsing NOT needed here (RealWorld uses Hurl, not a spec-diff).
