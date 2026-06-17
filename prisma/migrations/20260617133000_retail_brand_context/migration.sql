ALTER TABLE `conversations`
    MODIFY `pending_action` ENUM(
        'IDLE',
        'WAITING_MEDICINE_NAME',
        'WAITING_RETAIL_BRAND',
        'WAITING_PRESENTATION',
        'WAITING_QUANTITY',
        'WAITING_CEP',
        'WAITING_ADDRESS_NUMBER',
        'WAITING_CONFIRMATION',
        'WAITING_PIX'
    ) NOT NULL DEFAULT 'IDLE',
    ADD COLUMN `current_retail_category` VARCHAR(191) NULL;
