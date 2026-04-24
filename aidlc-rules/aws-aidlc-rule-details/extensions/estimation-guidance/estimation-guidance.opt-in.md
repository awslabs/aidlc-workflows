# Estimation Guidance — Opt-In

**Extension**: Estimation Guidance (AI-DLC Estimation Framing)

**Recommended when**: Stakeholders need effort estimates for planning but there is risk of confusing conventional developer-time estimates with AI-DLC execution time.

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: Estimation Guidance Extension

Should Units Generation include structured estimation guidance that
distinguishes AI-DLC execution time from conventional team estimates?

A) Yes — enable ESTIMATION GUIDANCE. Unit definitions will include
   relative complexity sizing (story points / T-shirt) for comparing
   units, and optionally a labeled conventional team estimate for
   stakeholder communication. Estimates will be clearly framed to
   prevent confusion with AI-DLC execution time.

B) No — skip structured estimation in unit definitions

X) Other (please describe)

[Answer]:
```
