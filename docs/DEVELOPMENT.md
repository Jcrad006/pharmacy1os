# Development Guide

This guide is written for contributors who may be new to software development.

## What the pieces do

- `apps/web`: the screens pharmacy staff will use.
- `apps/api`: the server that applies pharmacy rules and handles requests.
- `packages/db`: the database definition and database client.
- `docs`: explanations of architecture, security boundaries, and planned work.
- `.github/workflows/ci.yml`: GitHub's automated build/test check.

## Basic local startup

1. Install Node.js 22 or newer.
2. Install pnpm 10 or newer.
3. Install Docker.
4. Copy `.env.example` to `.env`.
5. Run `docker compose up -d db`.
6. Run `pnpm install`.
7. Run `pnpm db:generate`.
8. Run `pnpm dev`.

Then open http://localhost:5173.

## GitHub CI

Every push to `main` should run the CI workflow. The workflow installs dependencies, generates the Prisma database client, typechecks the TypeScript source, runs tests, and builds the applications.

A green CI check does not mean Pharmacy1OS is safe for production. It only means the current source code passed the automated development checks that exist at that time.

## Data rule

Use synthetic data only. Never use real patient data, real prescriptions, real credentials, or live pharmacy vendor accounts during development.
