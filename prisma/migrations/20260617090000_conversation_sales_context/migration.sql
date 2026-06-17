ALTER TABLE `conversations`
    ADD COLUMN `cart` JSON NULL,
    ADD COLUMN `pending_address` JSON NULL;
