# Services

> Minimum structure. Sections may be omitted with rationale or extended as needed.
> This artifact is relevant when the system has a service/orchestration layer distinct from its domain components. Omit if the system is a simple monolith with no service layer.

## Service Inventory

| Service | Purpose | Orchestrates |
|---|---|---|
| [name] | [what coordination it provides] | [which components it ties together] |

## Service Details

### [Service Name]

- **Purpose:** [why this orchestration exists as a distinct concern]
- **Coordinates:** [which components participate]
- **Trigger:** [what initiates this service — API call, event, schedule, etc.]
- **Outcome:** [what state the system is in when this service completes]
- **Error handling:** [what happens when a participant fails]
