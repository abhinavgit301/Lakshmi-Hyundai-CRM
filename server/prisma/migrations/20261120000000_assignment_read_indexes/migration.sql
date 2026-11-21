-- These additive indexes support the existing scoped reads; they do not enable the staging projection.
-- CREATE INDEX blocks writes on each target table while it builds. Apply only in an approved window.
CREATE INDEX "mcl_ccm_owner_created_id_idx"
  ON "master_call_lists" ("ccmId", "ownerUserId", "createdAt", "id");
CREATE INDEX "mcl_ccm_created_id_idx"
  ON "master_call_lists" ("ccmId", "createdAt", "id");
CREATE INDEX "allocation_ccm_cre_status_vehicle_idx"
  ON "allocations" ("ccmId", "creId", "status", "vehicleId");
CREATE INDEX "allocation_vehicle_ccm_status_cre_idx"
  ON "allocations" ("vehicleId", "ccmId", "status", "creId");
