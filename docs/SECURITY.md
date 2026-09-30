# Security Boundary

Pharmacy1OS is currently a development prototype and must not process real PHI.

## Development rules

- Use synthetic patient and prescription data only.
- Never commit passwords, API keys, certificates, tokens, or vendor credentials.
- Keep `.env` outside source control.
- Do not expose the development database to the public internet.
- Role definitions alone are not authentication.
- Do not enable regulated production integrations in development.

## Before real pharmacy use

Production deployment requires a formal program covering authentication, MFA where appropriate, least-privilege authorization, encryption in transit and at rest, key management, tamper-evident audit logging, backups, disaster recovery, incident response, vulnerability management, secrets management, environment isolation, session controls, access reviews, monitoring, and applicable vendor/regulatory requirements.

HIPAA, DEA, state-board, e-prescribing, controlled-substance, claims, and other requirements must be assessed for the actual deployment and workflow.
