## Technology stack

![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-ES_Modules-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Database-4169E1?logo=postgresql&logoColor=white)
![JWT](https://img.shields.io/badge/JWT-Authentication-000000?logo=jsonwebtokens&logoColor=white)
![ESLint](https://img.shields.io/badge/ESLint-Linting-4B32C3?logo=eslint&logoColor=white)

**Also used:** React Router, Axios, Recharts, Lucide React, TanStack React Virtual, bcrypt, PDFKit, CSV Parse, ExcelJS, and Node's built-in test runner.



# Lakshmi Hyundai CRM

Lakshmi Hyundai CRM is an internal customer and workshop management application for Hyundai dealership service operations. It supports customer and vehicle records, repair-order history, service follow-ups, calls, appointments, allocations, imports, performance analytics, and PDF reports.


## Repository structure

- `client/` — React and Vite frontend.
- `server/` — Express API, Prisma database access, application workflows, and PDF generation.
- `server/prisma/` — Prisma schema and migrations.
- `server/tests/` — backend tests using Node's built-in test runner.

## Features

### Customers and vehicles

- Search customer records by name, mobile number, VIN, registration number, or repair order.
- View customer profiles, vehicles, workshop visits, calls, and appointments.
- Use paginated customer lists and a separate customer-detail endpoint for large datasets.

### Master Call List and allocations

- Review workshop customers and their due-service information.
- Filter by team, CRE, due category, repair type, and text search.
- Assign records and allocate vehicle workload to CREs.
- Open customer profiles and initiate calls where permitted.
- Browse large lists using pagination and virtualized rows.

### Service workflows

Dedicated lists support One-Year Due, Six-Month Due, Free Service, Warranty, and follow-up work. Free Service milestones are based on the configured service calendar and grace period. A qualifying free-service visit during the grace period completes the milestone and reduces the remaining count. Workshop service history is retained; expired milestones do not delete history.

### Calls, follow-ups, and appointments

Users can record calls and outcomes, track customer reach and appointment conversion, create follow-ups, and manage workshop appointments. Access to customers and service categories depends on the user's role and permissions.

### Imports

Repair-order and monthly customer-data import workflows provide validation, import history, error reporting, and rollback support. Use the application's supported workflows for import recovery and rollback rather than modifying production data directly.

### Workshop Performance and Reports

Workshop Service Performance provides:

- **Load Analysis** — compare selected years or months, with service-category and total-service comparisons.
- **Load Trend** — inspect monthly service volumes and category trends.
- **MTD Load** — compare a selected month against the same month in a selectable comparison year. The default month is the previous completed month.

Service categories include Free Service, PMS, Accidental Repair, Running Repair, and Others. Reports and server-generated PDF exports provide analytics and operational summaries.

## User roles

| Role | Typical access |
| --- | --- |
| Admin | User administration, customers, imports, reports, and operational data |
| GM | Organization-wide customer, Master Call List, dashboard, report, and workshop analytics access |
| CCM | Team workload, CRE assignments, allocations, calls, follow-ups, and team analytics |
| CRE | Assigned customers, calls, follow-ups, appointments, and personal performance |
| Free-Service CRE | Free-service workflows with restricted general customer-record access |

The API is the authority for access control. Frontend navigation visibility does not replace server-side authorization.

## Technology

- **Frontend:** React 19, Vite, React Router, Axios, Recharts, Lucide React, and TanStack React Virtual.
- **Backend:** Node.js ES modules, Express 5, Prisma 7, PostgreSQL, bcrypt, JWT, PDFKit, CSV Parse, and ExcelJS.
- **Validation:** ESLint, Vite production build, and Node's built-in test runner.

## Requirements

- Node.js compatible with the versions required by the installed dependencies.
- PostgreSQL.
- Separate local development and test databases. Do not use production credentials for local tests.

## Local development

Install dependencies:

```powershell
cd .\server
npm install
cd ..\client
npm install
```

### Configure the server

Copy `server/.env.example` to `server/.env` and set values for your local environment:

```env
PORT=4000
DATABASE_URL=postgresql://postgres:password@localhost:5432/lakshmi_hyundai_crm?schema=public
JWT_SECRET=replace-with-a-random-secret-at-least-32-characters
NODE_ENV=development
WORKSHOP_TIMEZONE=Asia/Kolkata
```

### Configure the client

Copy `client/.env.example` to `client/.env`. For a local API, configure:

```env
VITE_API_BASE_URL=http://localhost:4000/api/v1
```

### Generate Prisma client and start services

Prepare the local schema as appropriate for your environment:

```powershell
cd .\server
npm run prisma:generate
npm run prisma:push
npm run dev
```

In another terminal:

```powershell
cd .\client
npm run dev
```

The API is mounted at `/api/v1`. Vite prints the local frontend URL when it starts.

## Environment variables

Required server configuration:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret used to sign authentication tokens |
| `NODE_ENV` | Runtime environment |
| `PORT` | Port provided by the runtime or hosting platform |
| `WORKSHOP_TIMEZONE` | Recommended IANA timezone for workshop-day calculations |

Optional performance configuration:

| Variable | Default / example | Purpose |
| --- | --- | --- |
| `NODE_OPTIONS` | `--max-old-space-size=3072` | Optional Node heap setting for a 4 GB service; leave memory for other process needs. |
| `REPORT_MASTER_LIST_PAGE_SIZE` | `10000` | Page size for workshop report reads. The code caps this at `20000` to limit Prisma query parameters. |
| `REPORT_CACHE_TTL_SECONDS` | `60` | Short-lived workshop report cache duration; `0` disables the cache. |
| `DB_POOL_MAX` | Driver default | Optional PostgreSQL pool maximum. Check the database connection limit before increasing it. |
| `CUSTOMERS_MEMORY_LOG` | Off | Enables memory/count diagnostics without logging customer personal data. |

The client variable `VITE_API_BASE_URL` is used at build time. After changing hosting environment variables, restart or redeploy the relevant service.

## API overview

Protected API routes are grouped under `/api/v1`, including:

- `/auth` — login, current-user lookup, and logout.
- `/customers` — customer list and detail access.
- `/teams` — team and CRE information.
- `/master-call-list` — list, filtering, and assignment workflows.
- `/calls` and `/follow-ups` — customer contact activity.
- `/appointments` — workshop appointments.
- `/allocations` — CRE workload assignments.
- `/imports` — data imports and import history.
- `/performance` — operational and workshop analytics.
- `/export` — server-generated PDF reports.

Authentication uses JWT. Route middleware and controllers enforce role permissions.

## Performance and data safeguards

- Customer lists use slim responses and pagination; full profiles load separately.
- Large Master Call List report reads are paged to stay below Prisma/database parameter limits.
- Workshop report responses use a short-lived cache and share concurrent identical requests.
- Large tables use pagination or virtualization.
- Increasing query batch sizes also increases per-query memory and database load; keep values within application caps.
- When report requests cover overlapping date ranges, duplicate dates must be deduplicated, not added together.
- Never point tests, import experiments, or rollback checks at a production database.

## Common commands

Frontend:

```powershell
cd .\client
npm run dev
npm run lint
npm run build
npm run preview
```

Backend:

```powershell
cd .\server
npm run dev
npm start
npm test
npm run prisma:generate
npm run prisma:push
```

Integration tests may require a separately configured test database. If a test fails due to missing mock data or an unavailable integration prerequisite, report that prerequisite rather than bypassing it.

## Security and operations

- Passwords are stored as bcrypt hashes and cannot be retrieved as plaintext. Use a password reset or temporary-password workflow.
- Do not commit or log database credentials, JWT secrets, passwords, customer names, phone numbers, or VINs.
- Enforce authorization on the server even when a client view is hidden.
- Use separate development and test databases for imports, rollback, and other destructive operations.
- Server startup performs maintenance tasks such as vehicle sale-date backfills and allocation consistency checks.
- Keep server-generated PDF exports synchronized with the performance filters and calculations shown in the frontend.

## License and data ownership

This is an internal Lakshmi Hyundai application. Follow organizational policy before sharing source code, customer data, or generated reports.
