# Mob Programming Guide

Practical guidance for effective mob programming (ensemble programming) as a team practice for knowledge sharing and high-quality delivery.

## What is Mob Programming?

Mob programming is the practice of the whole team working on the same thing, at the same time, in the same space (physical or virtual), at the same computer. It extends pair programming to the entire team.

Core principle: "All the brilliant minds working on the same thing, at the same time, in the same space, and at the same computer." — Woody Zuill

## Roles

### Driver
- The person at the keyboard. Types what the navigators direct.
- Does NOT make design decisions or solve problems independently.
- Focuses on translating spoken intent into code. Asks for clarification when directions are unclear.
- Think of the driver as a "smart input device" — capable and knowledgeable, but acting on group direction.

### Navigator(s)
- The rest of the team. They think, discuss, and direct the driver.
- One primary navigator speaks at a time to avoid overwhelming the driver.
- Navigators discuss approach, spot issues, suggest improvements, and think ahead.
- Different navigators bring different expertise: one thinks about design, another about edge cases, another about testing.

### Facilitator (optional, recommended for new mobs)
- Keeps the session on track. Manages rotation timer. Ensures everyone participates.
- Watches for dominant voices and draws quieter members into the conversation.
- Not a permanent role; rotate or remove once the team is comfortable with the practice.

## Rotation Cadence

- **Recommended interval**: 10-15 minutes per driver rotation.
- Use a timer (mobti.me, mob.sh CLI tool, or a simple kitchen timer).
- Everyone rotates through the driver role. No opt-outs; the practice only works with full participation.
- When the timer sounds, the current driver moves out, the next person in the rotation moves to the keyboard.
- The transition should be seamless: do not wait for a "good stopping point." Forcing handoff mid-thought builds shared understanding.

## Remote Mob Tooling

- **Screen sharing**: VS Code Live Share, JetBrains Code With Me, or plain screen share with remote control.
- **mob.sh**: CLI tool that automates git handoff. `mob start` creates a WIP branch; `mob next` commits and pushes for the next driver to pull. `mob done` squashes to a clean commit.
- **Timer tools**: mobti.me (web-based), mob.sh built-in timer, Cuckoo.team.
- **Communication**: Keep a persistent video call open. Audio quality matters more than video quality. Use a good microphone.
- **Shared notes**: Keep a shared document or whiteboard for parking lot items, decisions, and action items.

## When to Mob vs Pair vs Solo

| Situation | Recommended Practice |
|-----------|---------------------|
| New team member onboarding | Mob — fastest knowledge transfer |
| Complex design decision | Mob — multiple perspectives needed |
| Unfamiliar technology or domain | Mob — collective learning |
| Well-understood, repetitive work | Solo — mobbing adds overhead |
| Focused deep work (research, investigation) | Solo or pair — mob is too noisy |
| Code review backlog growing | Mob — eliminates the need for async review |
| Cross-team knowledge is siloed | Mob — breaks down silos |
| Time-sensitive bug fix | Pair or mob — faster diagnosis with multiple minds |

Mobbing is most valuable when uncertainty is high, knowledge needs to be shared, or quality matters more than raw throughput.

## Mob Session Facilitation

### Starting a Session
1. Agree on the goal: "By the end of this session, we want to have X."
2. Set the rotation timer.
3. Establish ground rules: respect the driver, one navigator speaks at a time, take breaks every 60-90 minutes.
4. Pull up all relevant context: tickets, design docs, existing code.

### During the Session
- If the mob gets stuck, take 5 minutes for silent individual research, then reconvene.
- Park tangential discussions on a visible "parking lot" list; address them later.
- If energy drops, take a break. A tired mob produces worse code than an individual.
- Celebrate small wins: passing tests, completing a feature, resolving a tricky bug.

### Ending a Session
- Commit and push all work (use `mob done` for a clean commit).
- Spend 5 minutes reviewing what was accomplished and what is left.
- Note any parking lot items that need follow-up.

## Knowledge Transfer Through Mobbing

- Mobbing is the fastest way to spread knowledge across a team. Every team member sees every decision in real time.
- New team members become productive faster because they absorb codebase knowledge, team conventions, and domain context simultaneously.
- Reduces bus factor to near zero: if one person leaves, the rest of the team has full context.
- Eliminates asynchronous code review: the review happens live, during development. Code is reviewed by the entire team before it is committed.

## Mob Retrospectives

After running mob sessions for 1-2 weeks, hold a retrospective specifically about the practice:

- **What is working well?** (knowledge sharing, fewer bugs, faster onboarding)
- **What is frustrating?** (rotation too fast/slow, some people dominating, fatigue)
- **What should we experiment with?** (different rotation time, mob only for complex work, include stakeholders)

Common adjustments:
- Increase rotation time if transitions feel disruptive (try 15-20 minutes).
- Decrease rotation time if the driver disengages or dominates (try 7-10 minutes).
- Mob for half the day and solo for the other half if energy is a concern.
- Use strong-style pairing rule: "For an idea to go from your head into the computer, it must go through someone else's hands."
