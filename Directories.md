# Directory Structure

This document describes the directory structure of the **Webhook Delivery Engine** project.

> **Spec-Driven Development (SDD)**: This project follows a strict Spec-Driven Development methodology using the Paperclip framework. All implementation code must map directly to formal specifications defined in the `specs/` directory.

## Root Level Files

| File/Directory     | Description                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `README.md`        | Project documentation and usage instructions                                                          |
| `LICENSE`          | License file (MIT)                                                                                    |
| `package.json`     | Project dependencies and scripts (pnpm workspace setup)                                               |
| `tsconfig.json`    | TypeScript configuration                                                                              |
| `vitest.config.ts` | Vitest testing framework configuration                                                                |
| `.nvmrc`           | Node.js version for local development                                                                 |
| `.prettierrc`      | Prettier code formatter configuration                                                                 |
| `.env.example`     | Example environment variables template                                                                |
| `.gitignore`       | Git ignore rules                                                                                      |
| `specs/`           | **Spec-driven development specifications (GIT TRACKED)** - See [`specs/README.md`](./specs/README.md) |

## Specification Directory (`specs/`)

The `specs/` directory is the **source of truth** for all business logic, API contracts, and type definitions. Per the Spec-Driven Development methodology:

1. **Code follows specs**: Implementation must map directly to documentation here
2. **Types first**: All TypeScript interfaces are declared in this directory before use
3. **Zod schemas**: Request/response validation schemas live here
4. **Git tracked**: Unlike source code, specs are committed and versioned

### Structure

```
specs/
├── api/                      # API endpoint specifications
│   ├── ingest-webhook.md    # POST /webhooks endpoint spec
│   └── status-check.md      # GET /webhooks/:id/status endpoint spec
├── core/                     # Core business logic specifications
│   ├── idempotency-contracts.md  # Idempotency key handling rules
│   ├── retry-strategy.md         # Retry logic and backoff configuration
│   └── webhook-lifecycle.md      # State machine definitions
├── types/                    # Shared type definitions
│   ├── webhook.ts           # Webhook event types
│   └── delivery.ts          # Delivery state types
└── README.md                 # This directory's documentation
```

### Writing a Specification

When documenting new behavior:

1. **Define the schema** - Use Zod schema syntax or TypeScript interfaces
2. **Document edge cases** - List all expected error conditions and handling
3. **Provide examples** - Include valid/invalid request samples
4. **Reference existing specs** - Link to related specifications when applicable

## Configuration Directories

| Directory       | Description                                            |
| --------------- | ------------------------------------------------------ |
| `.husky/`       | Git hooks for pre-commit validation and commit linting |
| `node_modules/` | Installed dependencies (not tracked in git)            |

## Source Code (`src/`)

```
src/
├── app.ts           # Express application setup and routes
├── config.ts        # Configuration settings (port, CORS origins, etc.)
├── logger.ts        # Logger initialization with Pino
├── server.ts        # HTTP server creation and startup logic
└── data/            # Data layer files
    └── webhook_engine.db  # SQLite database file
```

### `src/types/` - TypeScript Type Definitions

```
src/types/
├── config.ts        # Configuration interface definitions
└── errors.ts        # Custom error class and types
```

### `src/storage/` - Database Layer

```
src/storage/
├── db.ts            # Database connection and helper functions
├── schema.sql       # SQL database schema definitions
└── types.ts         # Database-related TypeScript types
```

## Tests (`tests/`)

```
tests/
├── server.test.ts   # Express server endpoint tests
└── storage.test.ts  # Database/storage operation tests
```

## Static Assets (`public/`)

| File          | Description                       |
| ------------- | --------------------------------- |
| `favicon.svg` | Web application favicon           |
| `icons.svg`   | SVG icons for the web application |

---

## Summary

```
webhook-delivery-engine/
├── .husky/                # Git hooks
├── node_modules/          # Dependencies (gitignored)
├── public/                # Static assets
│   ├── favicon.svg
│   └── icons.svg
├── specs/                 # **Spec-driven development specifications (GIT TRACKED)**
│   ├── api/              # API endpoint specifications
│   │   ├── ingest-webhook.md
│   │   └── status-check.md
│   ├── core/             # Core business logic specifications
│   │   ├── idempotency-contracts.md
│   │   ├── retry-strategy.md
│   │   └── webhook-lifecycle.md
│   ├── types/            # Shared type definitions
│   │   ├── webhook.ts
│   │   └── delivery.ts
│   └── README.md         # Spec directory documentation
├── src/                   # Application source code
│   ├── app.ts
│   ├── config.ts
│   ├── data/             # SQLite database
│   │   └── webhook_engine.db
│   ├── logger.ts
│   ├── server.ts
│   ├── storage/          # Database layer
│   │   ├── db.ts
│   │   ├── schema.sql
│   │   └── types.ts
│   └── types/            # Type definitions
│       ├── config.ts
│       └── errors.ts
├── tests/                 # Unit and integration tests
│   ├── server.test.ts
│   └── storage.test.ts
├── .env.example           # Environment variables template
├── package.json           # Dependencies & scripts
├── tsconfig.json          # TypeScript config
├── vitest.config.ts       # Vitest testing config
├── .nvmrc                 # Node.js version
├── .prettierrc            # Prettier config
├── .gitignore             # Git ignore rules
└── LICENSE                # MIT License
```

---

## Technology Stack

- **Runtime**: Node.js (as specified in `.nvmrc`)
- **Package Manager**: pnpm (workspaces enabled)
- **Web Framework**: Express.js
- **Database**: SQLite via `better-sqlite3`
- **Type Checking**: TypeScript
- **Testing**: Vitest
- **Formatting**: Prettier
- **Logging**: Pino
