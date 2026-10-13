# SDD — [System/Feature Name]

- Status, owner, date, linked PRD:

## Context, Goals, and Constraints

## Architecture and System Boundaries

## Modules and Responsibilities

## Data Model and Migration

## API / Event Contracts

## Key Flows

```mermaid
sequenceDiagram
    actor User
    participant App
    participant Service
    User->>App: Request
    App->>Service: Call
    Service-->>App: Response
    App-->>User: Result
```

## Security, Privacy, and Failure Modes

## Observability, Performance, and Accessibility

## Testing and Deployment

## Options, Trade-offs, and Related ADRs
