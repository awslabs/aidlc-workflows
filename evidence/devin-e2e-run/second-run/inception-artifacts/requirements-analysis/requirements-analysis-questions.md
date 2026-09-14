# Requirements Analysis — Questions

**Stage**: requirements-analysis
**Intent**: build a REST API for a todo app with CRUD endpoints
**Depth**: Minimal

A few focused questions to nail down the essentials before I write the requirements. Pick an option for each (A-E), or choose X to specify your own.

---

## Q1: Technology stack

What language and web framework should I build the API with? This drives every downstream code and test decision.

- A. Node.js with Express (JavaScript/TypeScript)
- B. Python with FastAPI
- C. Python with Flask
- D. Go with the standard library `net/http`
- X. Other (please specify)

[Answer]: A. Node.js with Express (JavaScript/TypeScript)

---

## Q2: Data storage

How should todos be persisted? This affects whether the API survives restarts and how complex the data layer gets.

- A. In-memory store (resets on restart — simplest, fine for a demo)
- B. SQLite file database (persistent, zero-config, single file)
- C. PostgreSQL (persistent, production-grade, needs a running instance)
- X. Other (please specify)

[Answer]: A. In-memory store (resets on restart — simplest, fine for a demo)

---

## Q3: Authentication

Does the API need authentication, or is it open for now?

- A. No authentication — open API (simplest)
- B. API key in a header
- C. JWT bearer tokens with a login endpoint
- X. Other (please specify)

[Answer]: A. No authentication — open API (simplest)

---

## Q4: Todo attributes

Beyond the basics, which fields should a todo have? The CRUD endpoints will manage these. (select all that apply)

- A. id, title, completed (the minimal set)
- B. Add description (longer text body)
- C. Add due date
- D. Add priority (e.g. low/medium/high)
- X. Other (please specify)

[Answer]: A. id, title, completed (the minimal set)

---

## Consolidated Summary Confirmation

- Tech stack: Node.js with Express
- Storage: In-memory store (resets on restart)
- Authentication: None — open API
- Todo fields: id, title, completed (minimal set)

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
