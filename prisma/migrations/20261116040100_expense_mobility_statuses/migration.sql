-- Before the two-step workflow, REJECTED meant "returned to the preparer" and APPROVED meant "ready to batch".
UPDATE "PettyCashVoucher" SET "status" = 'RETURNED' WHERE "status" = 'REJECTED';
UPDATE "PettyCashVoucher" SET "status" = 'CLEARED' WHERE "status" = 'APPROVED';
