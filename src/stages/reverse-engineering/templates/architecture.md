# System Architecture

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## System Overview

[High-level description of what the system is and how it's structured]

## Architecture Diagram

```mermaid
%% Replace with actual architecture diagram
%% Choose diagram type (graph, C4, flowchart) that best represents this system
```

## Component Descriptions

### [Package/Component Name]

- **Purpose:** [What it does]
- **Responsibilities:** [Key responsibilities]
- **Dependencies:** [What it depends on]
- **Type:** [Categorise as appropriate for this system]

## Data Flow

```mermaid
%% Replace with data flow visualisation
%% Choose diagram type (sequence, flowchart, graph) that best represents the flow
```

## Integration Points

Document all points where this system communicates with something outside its boundary. Organise by whatever grouping makes sense for this system (by protocol, by domain, by direction, etc.)

### [Integration Category]

| Name | Purpose | Protocol/Method | Auth |
|---|---|---|---|
| [name] | [why it exists] | [how it communicates] | [auth method] |

## Infrastructure Components

- **IaC approach:** [CDK/Terraform/CloudFormation/none/other]
- **Stacks:** [List with purposes]
- **Deployment model:** [Description]
- **Networking:** [Topology summary]
