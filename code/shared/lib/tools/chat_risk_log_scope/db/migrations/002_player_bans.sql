-- 002_player_bans：玩家封禁表
--
-- 说明：
--   1. end_at IS NULL 表示永久封禁。
--   2. 一个账号可能存在多条历史封禁；同一时刻只允许一条 active。
--   3. 手动解封只把 status 改为 lifted，不删除历史记录。
--   4. 重复执行本迁移是安全的（CREATE TABLE IF NOT EXISTS）。

USE `pi_chat_moderation`;

CREATE TABLE IF NOT EXISTS `chat_player_bans` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `account` VARCHAR(128) NOT NULL COMMENT '被封禁账号',
  `log_id` VARCHAR(64) NULL COMMENT '触发封禁的 chat_risk_logs.id',
  `judgement_id` BIGINT UNSIGNED NULL COMMENT '关联 chat_risk_judgements.id',
  `reason` INT NOT NULL COMMENT '风险类型编码',
  `label` VARCHAR(64) NOT NULL COMMENT '风险类型标签',
  `punishment` VARCHAR(32) NOT NULL COMMENT '处罚枚举：ban_1m/ban_1h/ban_1d/ban_3d/permanent',
  `duration_seconds` INT NULL COMMENT '封禁时长秒数；永久为 NULL',
  `start_at` DATETIME(3) NOT NULL COMMENT '封禁开始时间',
  `end_at` DATETIME(3) NULL COMMENT '封禁结束时间；NULL 表示永久',
  `status` ENUM('active','expired','lifted') NOT NULL DEFAULT 'active' COMMENT '封禁状态',
  `lifted_at` DATETIME(3) NULL COMMENT '提前解封时间',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_bans_account_status_end` (`account`, `status`, `end_at`),
  KEY `idx_bans_judgement` (`judgement_id`),
  CONSTRAINT `fk_bans_judgement`
    FOREIGN KEY (`judgement_id`) REFERENCES `chat_risk_judgements` (`id`)
    ON DELETE SET NULL
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='玩家封禁记录';
