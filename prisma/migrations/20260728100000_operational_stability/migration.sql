-- CreateEnum replacement for MySQL

-- AlterTable
ALTER TABLE `orders`
  ADD COLUMN `conversation_id` VARCHAR(191) NULL,
  ADD COLUMN `checkout_key` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `payments`
  ADD COLUMN `idempotency_key` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `order_items` (
  `id` VARCHAR(191) NOT NULL,
  `order_id` VARCHAR(191) NOT NULL,
  `type` ENUM('MEDICINE', 'RETAIL_PRODUCT') NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `brand` VARCHAR(191) NULL,
  `presentation` VARCHAR(191) NULL,
  `description` TEXT NULL,
  `quantity` INTEGER NOT NULL,
  `unit_price_cents` INTEGER NOT NULL,
  `total_cents` INTEGER NOT NULL,
  `image_url` TEXT NULL,
  `source` VARCHAR(191) NULL,
  `raw_payload` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_events` (
  `id` VARCHAR(191) NOT NULL,
  `provider` VARCHAR(191) NOT NULL,
  `event_id` VARCHAR(191) NULL,
  `status` ENUM('PENDING', 'PROCESSING', 'DONE', 'FAILED') NOT NULL DEFAULT 'PENDING',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `payload` JSON NULL,
  `error_message` TEXT NULL,
  `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `processed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `whatsapp_outbox` (
  `id` VARCHAR(191) NOT NULL,
  `conversation_id` VARCHAR(191) NOT NULL,
  `recipient` VARCHAR(191) NOT NULL,
  `content` TEXT NOT NULL,
  `status` ENUM('PENDING', 'SENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `next_attempt_at` DATETIME(3) NULL,
  `whatsapp_message_id` VARCHAR(191) NULL,
  `error_message` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `provider_request_logs` (
  `id` VARCHAR(191) NOT NULL,
  `trace_id` VARCHAR(191) NULL,
  `provider` VARCHAR(191) NOT NULL,
  `operation` VARCHAR(191) NOT NULL,
  `query` VARCHAR(191) NULL,
  `endpoint` TEXT NULL,
  `status_code` INTEGER NULL,
  `duration_ms` INTEGER NULL,
  `results_found` INTEGER NULL,
  `results_after_filter` INTEGER NULL,
  `outcome` ENUM('SUCCESS', 'EMPTY', 'FAILED', 'FALLBACK') NOT NULL,
  `failure_reason` TEXT NULL,
  `error_message` TEXT NULL,
  `raw_payload` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `orders_checkout_key_key` ON `orders`(`checkout_key`);

-- CreateIndex
CREATE INDEX `orders_conversation_id_idx` ON `orders`(`conversation_id`);

-- CreateIndex
CREATE UNIQUE INDEX `payments_idempotency_key_key` ON `payments`(`idempotency_key`);

-- CreateIndex
CREATE INDEX `order_items_order_id_idx` ON `order_items`(`order_id`);

-- CreateIndex
CREATE INDEX `order_items_type_idx` ON `order_items`(`type`);

-- CreateIndex
CREATE UNIQUE INDEX `webhook_events_provider_event_id_key` ON `webhook_events`(`provider`, `event_id`);

-- CreateIndex
CREATE INDEX `webhook_events_provider_status_idx` ON `webhook_events`(`provider`, `status`);

-- CreateIndex
CREATE INDEX `webhook_events_created_at_idx` ON `webhook_events`(`created_at`);

-- CreateIndex
CREATE INDEX `whatsapp_outbox_conversation_id_idx` ON `whatsapp_outbox`(`conversation_id`);

-- CreateIndex
CREATE INDEX `whatsapp_outbox_status_next_attempt_at_idx` ON `whatsapp_outbox`(`status`, `next_attempt_at`);

-- CreateIndex
CREATE INDEX `provider_request_logs_provider_created_at_idx` ON `provider_request_logs`(`provider`, `created_at`);

-- CreateIndex
CREATE INDEX `provider_request_logs_trace_id_idx` ON `provider_request_logs`(`trace_id`);

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `whatsapp_outbox` ADD CONSTRAINT `whatsapp_outbox_conversation_id_fkey` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
