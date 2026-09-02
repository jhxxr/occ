-- Funding-lot ownership: private direct credit and sold gift cards.
ALTER TABLE `DownstreamCreditLot`
  MODIFY `userId` INTEGER NULL,
  ADD COLUMN `redemptionId` VARCHAR(191) NULL,
  ADD COLUMN `ownership` VARCHAR(20) NOT NULL DEFAULT 'NONE',
  ADD COLUMN `faceValueRmb` DOUBLE NULL,
  ADD COLUMN `assumedNoFee` BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX `DownstreamCreditLot_redemptionId_key`
  ON `DownstreamCreditLot`(`redemptionId`);
CREATE INDEX `DownstreamCreditLot_downstreamId_ownership_occurredAt_idx`
  ON `DownstreamCreditLot`(`downstreamId`, `ownership`, `occurredAt`);

ALTER TABLE `DownstreamCreditLot`
  ADD CONSTRAINT `DownstreamCreditLot_redemptionId_fkey`
  FOREIGN KEY (`redemptionId`) REFERENCES `DownstreamRedemptionCode`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing Orbit-managed redeemed cards become public funding at face value.
-- The actual received amount is deliberately initialized to the face value: users can
-- edit it later to record the real card-network settlement and resulting fee.
INSERT INTO `DownstreamCreditLot` (
  `id`, `downstreamId`, `userId`, `redemptionId`, `ledgerKey`, `source`, `ownership`,
  `originalQuota`, `remainingQuota`, `faceValueRmb`, `cashBasisRmb`, `assumedNoFee`,
  `occurredAt`, `note`, `createdAt`, `updatedAt`
)
SELECT
  CONCAT('gift-', `r`.`id`), `r`.`downstreamId`, `r`.`usedUserId`, `r`.`id`,
  CONCAT('gift-sale:', `r`.`downstreamId`, ':', `r`.`remoteId`),
  'GIFT_CARD_SALE', 'PUBLIC', `r`.`quota`, `r`.`quota`,
  `r`.`quota` / NULLIF(`s`.`quotaPerDollar`, 0),
  `r`.`quota` / NULLIF(`s`.`quotaPerDollar`, 0), true,
  COALESCE(`r`.`redeemedAt`, `r`.`createdAt`),
  CONCAT('历史礼品卡，暂按无手续费：', `r`.`name`), NOW(), NOW()
FROM `DownstreamRedemptionCode` `r`
JOIN `DownstreamSite` `s` ON `s`.`id` = `r`.`downstreamId`
LEFT JOIN `DownstreamCreditLot` `existing`
  ON `existing`.`ledgerKey` = CONCAT('gift-sale:', `r`.`downstreamId`, ':', `r`.`remoteId`)
WHERE `r`.`giftManaged` = true
  AND `r`.`status` = 3
  AND `r`.`usedUserId` IS NOT NULL
  AND `r`.`quota` > 0
  AND `existing`.`id` IS NULL;
