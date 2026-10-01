CREATE TYPE "PickupFulfillmentMode" AS ENUM ('WILL_CALL', 'IMMEDIATE');

ALTER TABLE "PointOfSaleTransaction"
  ADD COLUMN "pickupFulfillmentMode" "PickupFulfillmentMode" NOT NULL DEFAULT 'WILL_CALL';
