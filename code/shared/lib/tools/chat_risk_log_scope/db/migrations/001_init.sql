-- chat_risk_log_scope 数据库初始化
-- 数据库：pi_chat_moderation
-- 表：
--   1. chat_risk_logs        原始聊天日志（不含任何判定字段）
--   2. chat_risk_judgements  Agent 独立判断结果

CREATE DATABASE IF NOT EXISTS `pi_chat_moderation`
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `pi_chat_moderation`;

CREATE TABLE IF NOT EXISTS `chat_risk_logs` (
  `id` VARCHAR(64) NOT NULL COMMENT '日志唯一标识',
  `request_id` VARCHAR(64) NULL COMMENT '请求标识',
  `account` VARCHAR(128) NOT NULL COMMENT '账号（可脱敏）',
  `nickname` VARCHAR(128) NULL COMMENT '昵称',
  `app_id` VARCHAR(64) NULL COMMENT '应用标识',
  `area_id` VARCHAR(64) NULL COMMENT '区服 ID',
  `area_name` VARCHAR(64) NULL COMMENT '区服名称',
  `server_id` VARCHAR(64) NULL COMMENT '服务器 ID',
  `context_messages` JSON NULL COMMENT '上下文消息数组',
  `current_message` TEXT NOT NULL COMMENT '待判断消息原文',
  `context_type` VARCHAR(32) NULL COMMENT '聊天场景',
  `create_time` DATETIME(3) NULL COMMENT '消息创建时间（毫秒精度）',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '入库时间',
  PRIMARY KEY (`id`),
  KEY `idx_logs_create_time` (`create_time`),
  KEY `idx_logs_account` (`account`),
  KEY `idx_logs_area_server` (`area_id`, `server_id`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='原始聊天风险日志（无判定标签）';

CREATE TABLE IF NOT EXISTS `chat_risk_judgements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `log_id` VARCHAR(64) NOT NULL COMMENT '关联 chat_risk_logs.id',
  `is_risk` TINYINT(1) NOT NULL COMMENT '是否违规',
  `reason` INT NOT NULL COMMENT '风险类型编码，-1 表示正常',
  `label` VARCHAR(64) NOT NULL COMMENT '风险类型标签',
  `confidence` DECIMAL(5,4) NOT NULL COMMENT 'Agent 置信度 0~1',
  `action` VARCHAR(32) NOT NULL COMMENT '处置动作',
  `evidence` JSON NULL COMMENT '判断证据原文数组',
  `agent_model` VARCHAR(128) NULL COMMENT 'Agent 模型标识',
  `judged_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '判断时间',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_judgements_log_id` (`log_id`),
  KEY `idx_judgements_reason` (`reason`),
  KEY `idx_judgements_action` (`action`),
  KEY `idx_judgements_judged_at` (`judged_at`),
  CONSTRAINT `fk_judgements_log`
    FOREIGN KEY (`log_id`) REFERENCES `chat_risk_logs` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Agent 独立判断结果';
