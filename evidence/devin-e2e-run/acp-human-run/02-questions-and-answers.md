# Questions AI-DLC asked, and the person's answers

## Question 1

**Plan**

```
I'd run the "express" plan for your habit tracker (add a habit, check it off for today, show each habit's current streak, saved to JSON, with tests): 6 stages, 6 approval gates. Do you want me to go ahead with it, use a different plan, or tailor one to this task?
```

Options: `Go ahead with the "express" plan` · `Use a different plan` · `Tailor a plan to this task` · (own words allowed)

**Answer:** Express is fine, but keep plan approval and summary confirmation on like I asked.  _(typed in own words)_

## Question 2

**Answer mode**

```
I've created 4 questions at aidlc/spaces/default/intents/261023-habit-tracker/inception/requirements-analysis/requirements-analysis-questions.md. How would you like to answer them?
```

Options: `Guide me` · `I'll edit the file` · `Chat` · (own words allowed)

**Answer:** Guide me

## Question 3

**Streak rule**

```
Q1. How should the current streak be counted? (The streak depends on how a day that hasn't been checked off yet is treated.)
```

Options: `A. Grace for today` · `B. Strict, ends today` · `C. Longest ever` · (own words allowed)

**Answer:** A. Grace for today

**Edge cases**

```
Q2. What should happen when a habit is checked off twice in one day, or a habit that was never added is named?
```

Options: `A. No-op / error` · `B. Error / error` · `C. No-op / auto-create` · (own words allowed)

**Answer:** A. No-op / error

**Storage**

```
Q3. Where should the JSON file live by default?
```

Options: `A. ./habits.json + --file` · `B. ~/.habits.json + --file` · `C. ./habits.json fixed` · (own words allowed)

**Answer:** B. ~/.habits.json + --file

**Stack**

```
Q4. Which Python version and libraries should the tool use?
```

Options: `A. Stdlib + pytest` · `B. Stdlib + unittest` · `C. click + pytest` · (own words allowed)

**Answer:** B. Stdlib + unittest

## Question 4

**Confirm**

```
**Stage:** Requirements Analysis
**Confirming:** Consolidated answers in `aidlc/spaces/default/intents/261023-habit-tracker/inception/requirements-analysis/requirements-analysis-questions.md` before generating `aidlc/spaces/default/intents/261023-habit-tracker/inception/requirements-analysis/requirements.md`, `aidlc/spaces/default/intents/261023-habit-tracker/inception/requirements-analysis/requirements-analysis-questions.md`.
**Why now:** All stage questions are answered; artifact generation will use this confirmed summary.
**Decision options:**
- **Looks correct** - record this confirmation  …
```

Options: `Looks correct` · `Request changes` · (own words allowed)

**Answer:** Looks correct

## Question 5

**Approval**

```
# :mag: Requirements Analysis Complete

- 4 functional requirement groups: add a habit (FR1), check off for today (FR2), show current streaks (FR3), data file location (FR4), 11 sub-requirements with acceptance examples
- Streak rule written precisely: count back from today if checked, otherwise from yesterday; 0 if neither
- 5 non-functional requirements: Python 3.10+ stdlib only, unittest tests with an injectable "today", clean error on a corrupt file, readable JSON with ISO dates, errors to stderr
- Assumptions: local calendar date, single user, run as `python -m habit_tracker`, exact case- …
```

Options: `Approve` · `Request Changes` · (own words allowed)

**Answer:** Request changes: habit names should not be case-sensitive. If I add "Read" and later type "read", it should be the same habit, and adding "read" when "Read" exists should be refused as a duplicate.  _(typed in own words)_

## Question 6

**Approval**

```
# :mag: Requirements Analysis Complete

- Revised: habit names are now case-insensitive everywhere (new FR1.4). FR1.2 refuses "read" as a duplicate when "Read" exists, `check read` checks off "Read", and the habit keeps the spelling it was first added with. Two new acceptance examples cover this, and the tests must include it (NFR2)
- 4 functional requirement groups: add (FR1), check off for today (FR2), current streaks (FR3), data file location (FR4), 12 sub-requirements
- 5 non-functional requirements: Python 3.10+ stdlib only, unittest tests with an injectable "today", clean error on a corr …
```

Options: `Approve` · `Request Changes` · (own words allowed)

**Answer:** Approve

## Question 7

**Plan**

```
The plan is at aidlc/spaces/default/intents/261023-habit-tracker/construction/code-generation/code-generation-plan.md
- Builds: a stdlib-only Python CLI (`python -m habit_tracker`) with `add`, `check` and `streaks` commands, saving to `~/.habits.json` or a `--file` path
- Touches: new `habit_tracker/` package (`storage.py`, `core.py`, `cli.py`, `__main__.py`), new `tests/` folder, `README.md`, `.gitignore`
- Tests: about 22 `unittest` unit tests across storage, business logic and CLI, covering every requirement including case-insensitive names and error cases

Approve the code plan?
```

Options: `Approve Plan` · `Request Changes` · `I'll edit the files` · (own words allowed)

**Answer:** Approve Plan

## Question 8

**Approval**

```
# :computer: Code Generation Complete

- New `habit_tracker/` package: `storage.py` (`~/.habits.json` default, atomic saves, a corrupt file gives a clear error and is never overwritten), `core.py` (case-insensitive names, the streak rule, add/check rules), `cli.py` (`add`, `check`, `streaks`, `--file` before or after the command, errors to stderr)
- Run it with `python3 -m habit_tracker add Read`, `... check read`, `... streaks`
- 28 `unittest` tests, **all passing**: 5 storage, 13 core, 10 CLI. Every requirement has at least one test, and no test touches your real `~/.habits.json`
- No tests  …
```

Options: `Approve` · `Request Changes` · (own words allowed)

**Answer:** Approve

## Question 9

**Approval**

```
# :hammer: Build and Test Complete

- Build check: every module compiles cleanly on Python 3.10.12; nothing to install
- Unit tests: **28/28 passed** (5 storage, 13 core, 10 CLI) with the one command `python3 -m unittest tests.test_storage tests.test_core tests.test_cli -v`
- Smoke run of the real command line: `add Read`, `check read`, `check READ` (friendly no-op), `add read` (refused as a duplicate, exit 1), `streaks` → `Read: 1 day`
- Requirement coverage: all 18 requirement IDs built and tested; nothing uncovered
- All 8 targets Met (one test per requirement, a happy path per component, s …
```

Options: `Approve` · `Request Changes` · (own words allowed)

**Answer:** Approve
