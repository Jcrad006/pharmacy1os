# Python exception-board migration — synthetic read-only increment

The Python `ExceptionService` consolidates **unresolved** clinical DUR issues, prescriptions on hold, pharmacist-review work, and pending future-fill scheduling into a single queryable, site-restricted worklist. Filters, severity ordering, date-scoped schedule visibility, text search, response limit and the native Qt Exceptions display are implemented for synthetic testing. `GET /api/exceptions` uses the existing development-only actor dependency.

**Not equivalent to the original TypeScript exceptions workbench:** completion fills and follow-up exceptions from emergency supplies, biologic communication tasks, clinical event sources that have not been migrated, and live notification/escalation controls remain absent. This view must **not** be presented as a comprehensive clinical safety dashboard. Do not use with real patient data.
