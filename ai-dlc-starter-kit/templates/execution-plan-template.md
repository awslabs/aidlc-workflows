<plan_metadata>
  <name>Task Name</name>
  <date>YYYY-MM-DD</date>
  <based_on>.aidlc/docs/requirements.md</based_on>
</plan_metadata>

<architecture_overview>
## Overview
High-level architecture and approach summary. How does this fit into the existing system?
</architecture_overview>

<files_to_create>
## Files to Create
- <file action="create">`path/to/file.ext` — Purpose and responsibility</file>
</files_to_create>

<files_to_modify>
## Files to Modify
- <file action="modify">`path/to/file.ext` — What changes and why</file>
</files_to_modify>

<files_to_delete>
## Files to Delete
- <file action="delete">`path/to/file.ext` — Reason for removal</file>
</files_to_delete>

<execution_steps>
## Implementation Steps

<step id="1" action="create">
  <title>Step title</title>
  <file>path/to/file.ext</file>
  <description>What to implement in this step</description>
  <tests>How to verify this step</tests>
  <dependencies>Steps that must be done first</dependencies>
</step>

<step id="2" action="modify">
  <title>Step title</title>
  <file>path/to/file.ext</file>
  <description>What to change and why</description>
  <tests>How to verify this step</tests>
  <dependencies>none</dependencies>
</step>
</execution_steps>

<edge_cases>
## Edge Cases to Handle
- <case name="empty">Empty/null state</case>
- <case name="error">Error state</case>
- <case name="loading">Loading state</case>
- <case name="boundary">Boundary/limit conditions</case>
</edge_cases>

<migration_plan>
## Migration Plan (Brownfield only)
<step>Data migration procedure</step>
<step>Rollback strategy if migration fails</step>
<step>Compatibility verification</step>
</migration_plan>

<test_plan>
## Test Plan
<unit_tests>
- Test case 1: description
- Test case 2: description
</unit_tests>
<integration_tests>
- Test case 1: description
</integration_tests>
<manual_verification>
- Scenario 1: steps to verify manually
</manual_verification>
</test_plan>

<risks>
## Risks
- <risk severity="low|medium|high">Risk description and mitigation</risk>
</risks>
