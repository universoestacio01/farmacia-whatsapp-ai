ALTER TABLE `orders`
  MODIFY `status` ENUM('DRAFT', 'CONFIRMED', 'PENDING_PAYMENT_MANUAL', 'PAID', 'CANCELLED', 'DELIVERED') NOT NULL DEFAULT 'DRAFT';

ALTER TABLE `payments`
  MODIFY `status` ENUM('PENDING', 'PAID', 'EXPIRED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
  MODIFY `provider` VARCHAR(191) NULL DEFAULT 'manual',
  ADD COLUMN `amount` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `provider_transaction_id` VARCHAR(191) NULL,
  ADD COLUMN `pix_copy_paste` TEXT NULL,
  ADD COLUMN `pix_qr_code` TEXT NULL,
  ADD COLUMN `payment_url` VARCHAR(191) NULL,
  ADD COLUMN `raw_response` JSON NULL;

UPDATE `payments`
SET `amount` = ROUND(`amount_cents` / 100, 2)
WHERE `amount` = 0 AND `amount_cents` > 0;

CREATE UNIQUE INDEX `payments_provider_transaction_id_key` ON `payments`(`provider_transaction_id`);
CREATE INDEX `payments_provider_idx` ON `payments`(`provider`);
