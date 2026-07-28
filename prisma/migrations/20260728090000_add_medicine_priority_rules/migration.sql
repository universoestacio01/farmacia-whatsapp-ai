CREATE TABLE `medicine_priority_rules` (
  `id` VARCHAR(191) NOT NULL,
  `principle_active` VARCHAR(191) NOT NULL,
  `dosage_mg` INTEGER NULL,
  `dosage_text` VARCHAR(191) NULL,
  `quantity` INTEGER NULL,
  `form_group` VARCHAR(191) NULL,
  `brand` VARCHAR(191) NULL,
  `priority` INTEGER NOT NULL DEFAULT 100,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `medicine_priority_rules_principle_active_enabled_idx`
  ON `medicine_priority_rules`(`principle_active`, `enabled`);
