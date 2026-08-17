# pdlc prioritization frameworks

Reference for `pdlc-prioritization`. Two weighted scoring models — one for
Agentic candidates, one for Application candidates — plus the anchors that make
a 0-10 score mean the same thing twice. Pure reference: the stage owns the
procedure, the questions, and the grounding contract.

## Why two frameworks

Agentic and Application candidates fail for different reasons.

An **Application** candidate fails when the data is not there, when the platform
cannot carry it, or when nobody uses it. Its risks are delivery risks, and they
are largely knowable in advance.

An **Agentic** candidate fails when nobody can tell whether a run was good, when
being wrong is expensive and cannot be undone, or when the "autonomy" adds
nothing a fixed path would not have done. Its risks are control risks, and they
surface after the thing is running.

Score both on one sheet of criteria and the minority class's real risks become
invisible — they simply have no column. The class comes from upstream
(`pdlc-use-case-intake` classifies use cases, `pdlc-solution-analysis` classifies
derived candidates) and turns on control flow, not model usage.

## Agentic framework

For candidates where the system decides its own next step.

| # | Criterion | Weight | What it asks |
|---|---|---|---|
| 1 | Decision Value | 25 | Is the *choosing* the value? |
| 2 | Task Boundedness | 20 | Can success be recognised? |
| 3 | Tool & Data Access | 15 | Can the agent reach what it needs? |
| 4 | Cost of Being Wrong | 15 | How reversible is a wrong autonomous action? |
| 5 | Human Oversight Fit | 15 | Is there a review point that does not erase the benefit? |
| 6 | Evaluation Feasibility | 10 | Can good runs be told from bad ones, repeatably? |

**1. Decision Value (25)** — the highest weight, because it is the criterion that
distinguishes an agentic bet from an expensive way to do something simple.

- **0** — the path is fixed and known; a script would do this. Agency is
  decoration.
- **5** — the path varies, but a human picks correctly in seconds when they
  have the screen open.
- **10** — the choosing is the work: it depends on context a human would have
  to assemble, happens more often than a human can attend to, or is done
  inconsistently by people today.

**2. Task Boundedness (20)** — an agent without a recognisable stopping condition
does not finish, it stops.

- **0** — no definition of done; the goal is a direction ("improve the
  process").
- **5** — done is judgeable by a person looking at the output, case by case.
- **10** — done is checkable: a test passes, a total balances, a record
  matches, a schema validates.

**3. Tool & Data Access (15)** — the most common reason an agentic prototype
stalls in week one.

- **0** — required systems have no API, or access needs an approval nobody
  will grant.
- **5** — the systems exist and are reachable; permissions need a request that
  will plausibly succeed.
- **10** — every system is already reachable with credentials the team holds.

**4. Cost of Being Wrong (15)** — scored on reversibility, so **10 means cheap
and reversible**, not "high risk". Read the direction carefully; this criterion
is the one most often scored backwards.

- **0** — a wrong action moves money, sends external communication, deletes
  data, or creates a regulatory obligation.
- **5** — a wrong action costs rework, caught by a downstream human.
- **10** — a wrong action is a draft nobody has acted on yet.

**5. Human Oversight Fit (15)** — whether supervision is possible without
cancelling the point.

- **0** — either no natural review point exists, or reviewing every action
  costs as much as doing the work.
- **5** — batch review is workable: a person checks a day's output.
- **10** — there is an existing approval step in the workflow the agent can
  hand into.

**6. Evaluation Feasibility (10)** — lowest weight because it is usually
solvable, but the one that decides whether you can ever improve the thing.

- **0** — quality is a matter of opinion, judged fresh each time.
- **5** — a rubric exists; a human can grade a sample consistently.
- **10** — an automatic check or a labelled set can score runs without a human
  in the loop.

## Application framework

For candidates where the control flow is authored — including software with an AI
feature inside it.

| # | Criterion | Weight | What it asks |
|---|---|---|---|
| 1 | User Value | 25 | Does it materially change the user's day? |
| 2 | Frequency & Reach | 20 | How many users, how often? |
| 3 | Technical Feasibility | 15 | Buildable with what the team has? |
| 4 | Data Readiness | 15 | Does the data exist, clean, accessible, permitted? |
| 5 | Time to First Value | 15 | How soon does a user see something real? |
| 6 | Strategic Fit | 10 | Does it move the business where it said it was going? |

**1. User Value (25)**

- **0** — a nice-to-have the user would not notice was gone.
- **5** — a real improvement the user would choose if it were free.
- **10** — removes something the user complains about unprompted.

**2. Frequency & Reach (20)** — value multiplied by how often it lands. A large
benefit once a quarter loses to a small benefit every morning.

- **0** — one team, occasionally.
- **5** — one department, weekly.
- **10** — most of the target population, daily or per transaction.

**3. Technical Feasibility (15)**

- **0** — needs a platform, skill, or integration the organisation does not
  have.
- **5** — buildable, with one genuinely new thing to learn.
- **10** — squarely within what the team already ships.

**4. Data Readiness (15)** — four separate questions collapsed into one score;
the *lowest* of the four governs. Existence, accessibility, quality, and
permission. Data that exists but may not be used for this purpose scores 0, not 7.

- **0** — the data does not exist, cannot be reached, or is not permitted for
  this use.
- **5** — it exists and is reachable, and needs cleaning or joining.
- **10** — clean, accessible, and cleared.

**5. Time to First Value (15)**

- **0** — nothing observable for two quarters or more.
- **5** — a usable slice in a quarter.
- **10** — something a real user can try in weeks.

**6. Strategic Fit (10)** — deliberately the lowest weight. It is the criterion
most easily used to justify a predetermined answer, because "strategic" is
unfalsifiable. Score it against a *written* strategy or score it 5.

- **0** — pulls against a stated commitment.
- **5** — neutral; neither advances nor obstructs.
- **10** — directly advances a commitment the business has already made in
  writing.

## The arithmetic

Weighted total = `Σ(score × weight) / 100`. Both frameworks total 100 in weight,
so both totals land on a 0-10 scale and are comparable in magnitude — though not
in meaning, because the criteria differ. A cross-class ranking is a useful single
list and a bad tiebreaker; when an Agentic 7.1 sits above an Application 7.0, the
ranking has not separated them.

Show the arithmetic in the artifact. A weighted total a reader cannot recompute is
a number they have to trust, and the entire purpose of scoring is producing
numbers that do not need to be trusted.

## Adjusting weights

Weights are a starting point, agreed with the user **before** any score is seen.
Legitimate adjustments, each recorded with its reason:

- A team under a hard delivery deadline raises **Time to First Value**.
- A regulated or safety-critical context raises **Cost of Being Wrong** and
  **Human Oversight Fit**.
- A team with no evaluation practice raises **Evaluation Feasibility**, because
  for them it is not a solvable detail.
- A first agentic project raises **Task Boundedness**, because an unbounded
  first attempt teaches nothing.

Adjusting weights *after* seeing scores is not prioritization; it is rationalising
a choice already made. If the ranking contradicts a strong intuition, the honest
moves are to write down the criterion the framework is missing, or to record the
disagreement — not to retune until the intuition wins.

## Reading the output honestly

- **Near-ties do not decide.** Within one point, report that the scores do not
  separate the candidates and name the evidence that would.
- **Assumption-heavy leaders are research tasks.** Track how many of a
  candidate's six criteria rest on something the user actually stated. A
  first-place finish on four assumptions is a signal to go and find out, not to
  go and build.
- **The do-nothing baseline belongs in the table.** Every score is implicitly
  measured against keeping the workaround, so make it explicit and score it.
- **Six criteria cannot carry a decision alone.** The framework structures the
  argument and makes the reasoning inspectable. It does not replace judgment, and
  a team that treats the total as the answer has automated the part that was
  never the problem.

## Known limitations

The weights are defaults chosen for a general audience, not measured constants —
no calibration study sits behind the specific 25/20/15/15/15/10 split. Scores are
self-reported by the people who want the project. Both frameworks are silent on
cost, on dependency between candidates (two that share a platform investment are
cheaper together), and on sequencing. Treat the output as an argument made
legible, and read the rationales rather than the totals.
