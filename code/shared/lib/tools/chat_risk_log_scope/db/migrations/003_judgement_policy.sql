-- 003_judgement_policy：为 chat_risk_judgements 增加处罚审计字段
--
-- 只有一条 ALTER 语句，保证迁移的原子性：
-- 重复执行时会因列已存在而报 ER_DUP_FIELDNAME，由 apply-schema.ts 捕获并跳过。

USE `pi_chat_moderation`;

ALTER TABLE `chat_risk_judgements`
  ADD COLUMN `punishment_requested` VARCHAR(32) NULL COMMENT 'Agent 建议的处罚枚举' AFTER `evidence`,
  ADD COLUMN `punishment_applied` VARCHAR(32) NULL COMMENT '服务端护栏后实际执行的处罚枚举' AFTER `punishment_requested`,
  ADD COLUMN `ban_seconds` INT NULL COMMENT '实际封禁秒数；永久为 NULL' AFTER `punishment_applied`,
  ADD COLUMN `policy_adjusted` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否被服务端降级' AFTER `ban_seconds`,
  ADD COLUMN `policy_note` VARCHAR(255) NULL COMMENT '降级/复核原因' AFTER `policy_adjusted`;
