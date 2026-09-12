# Brownfield task definition — BUGFIX: httpbin `/base64` error handling

> This is the authoritative spec for the `bugfix` task type (FR-1.2). It defines
> the testbed, the seeded "broken" starting state, the task prompt the model
> receives, and the objective scoring oracle. The harness work (#10 seeding,
> #11 contract runner) implements exactly what this doc requires — nothing more.

## Testbed

- **Repo**: `psf/httpbin` (the MAINTAINED fork; `postmanlabs/httpbin` is dead
  since 2018 and does not import on Python 3.13).
- **Commit**: `f7b02ae` (v0.10.4, 2026-06-16).
- **License**: ISC / MIT (dual; permissive — vendorable).
- **Stack**: Flask / WSGI. ~3.3K LOC. No database, no external services.
- **Contract**: native flasgger **Swagger 2.0** served at `/spec.json`.
- **Boot (verified on 3.13)**: `pip install flask flasgger brotlicffi decorator
  werkzeug`; install httpbin as a package (a bare PYTHONPATH import fails a
  `importlib.metadata.version("httpbin")` lookup); `httpbin.app` is the WSGI app,
  61 routes, `/spec.json` → 200 Swagger 2.0.

## Seeded starting state (author-controlled delta)

Seed a PRISTINE copy of httpbin. The bug is **already latent** in
`httpbin/core.py::decode_base64` (route `/base64/<value>`, ~line 1308) — no
delta needed to introduce it, we just leave it:

```python
@app.route("/base64/<value>")
def decode_base64(value):
    encoded = value.encode("utf-8")
    try:
        return base64.urlsafe_b64decode(encoded).decode("utf-8")
    except:                                    # <-- bare except: swallows ALL errors
        return "Incorrect Base64 data try: SFRUUEJJTiBpcyBhd2Vzb21l"   # 200, generic string
```

Two real defects: (1) a bare `except:` that catches everything and (2) any
input — valid or not — is returned with Flask's default `text/plain`... actually
served without an explicit safe content type, and malformed input returns HTTP
**200** with a generic string rather than a client-error status.

**Scope decision (2026-08-04): ERROR-HANDLING ONLY.** We do NOT score the
XSS/Content-Type angle (awkward to assert via a pure endpoint contract). The
task is strictly about correct status/body on valid vs invalid input.

## Task prompt (given to the model — "modify this repo", not "build from vision")

> The `/base64/<value>` endpoint decodes a base64url-encoded path segment.
> Currently, malformed base64 input is silently swallowed by a bare `except:`
> and the endpoint returns HTTP 200 with a generic hint string — indistinguishable
> from a successful decode. Fix `decode_base64` so that:
> 1. Valid base64url input still decodes and returns the decoded text with HTTP 200.
> 2. Malformed/undecodable input returns a **client-error status (400)** with a
>    clear error message, NOT a 200 and NOT a 500.
> 3. The bare `except:` is replaced with a specific exception catch.
> Do not change the endpoint's path or its success behavior.

## Scoring oracle (Swagger-2.0 / endpoint contract path)

Objective, three assertions the contract runner makes after booting the WSGI app:

| # | Request | Expected |
|---|---|---|
| 1 | `GET /base64/SFRUUEJJTiBpcyBhd2Vzb21l` (valid) | 200, decoded body |
| 2 | `GET /base64/not-valid-base64-input` (bad chars) | **400** (client error) |
| 3 | `GET /base64/a` (wrong length → raises) | **400**, not 200 |

Pass = all three. The pristine/broken repo fails #2 and #3 (returns 200).
NOTE: inputs must be ones Python's `urlsafe_b64decode` actually REJECTS —
`====` / `@@@@` silently decode to empty bytes (no exception), so they are
NOT valid "malformed" cases; `a` and `not-valid-base64-input` genuinely raise
`binascii.Error`. Verified: reference fix (catch `binascii.Error`/`ValueError`,
return 400) flips the seed from 1/3 → 3/3.
A correct fix flips them to pass. Existing httpbin test suite must still pass
(no regression) — run its pytest as a secondary gate.

## Harness needs (scopes #11)

- **Boot**: Flask/WSGI app via a WSGI server (not uvicorn/ASGI). Discover
  `httpbin.app` (or generic `app`/`application` WSGI callable).
- **Scoring**: direct HTTP assertions on status + body (no Hurl needed for this
  task). Swagger-2.0 `/spec.json` parsing is OPTIONAL for this task — the three
  assertions above are hand-specified, not spec-derived. (Keep the Swagger-2.0
  parser out of scope unless the feature task or a later task needs it.)
