-- Stage 3M.2 additive roles; no prior staff privileges are automatically elevated.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'PHARMACIST_IN_CHARGE';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'INVENTORY_MANAGER';
