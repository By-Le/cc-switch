//! 故障转移队列 DAO
//!
//! 管理代理模式下的故障转移队列（基于 providers 表的 in_failover_queue 字段）

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::provider::{Provider, ProviderLoadLimits};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// 故障转移队列条目（简化版，用于前端展示）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailoverQueueItem {
    pub provider_id: String,
    pub provider_name: String,
    pub sort_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_limits: Option<ProviderLoadLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_notes: Option<String>,
}

impl Database {
    /// 获取故障转移队列（按 sort_index 排序）
    pub fn get_failover_queue(&self, app_type: &str) -> Result<Vec<FailoverQueueItem>, AppError> {
        let conn = lock_conn!(self.conn);

        let mut stmt = conn
            .prepare(
                "SELECT id, name, sort_index, notes, meta
                 FROM providers
                 WHERE app_type = ?1 AND in_failover_queue = 1
                 ORDER BY COALESCE(sort_index, 999999), id ASC",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        let items = stmt
            .query_map([app_type], |row| {
                Ok(FailoverQueueItem {
                    provider_id: row.get(0)?,
                    provider_name: row.get(1)?,
                    sort_index: row.get(2)?,
                    provider_notes: row.get(3)?,
                    load_limits: provider_load_limits_from_meta(row.get(4)?),
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(items)
    }

    /// 获取故障转移队列中的供应商（完整 Provider 信息，按顺序）
    pub fn get_failover_providers(&self, app_type: &str) -> Result<Vec<Provider>, AppError> {
        let all_providers = self.get_all_providers(app_type)?;

        let result: Vec<Provider> = all_providers
            .into_values()
            .filter(|p| p.in_failover_queue)
            .collect();

        Ok(result)
    }

    /// 添加供应商到故障转移队列
    pub fn add_to_failover_queue(&self, app_type: &str, provider_id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);

        conn.execute(
            "UPDATE providers SET in_failover_queue = 1 WHERE id = ?1 AND app_type = ?2",
            rusqlite::params![provider_id, app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(())
    }

    /// 从故障转移队列中移除供应商
    pub fn remove_from_failover_queue(
        &self,
        app_type: &str,
        provider_id: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);

        // 1. 从队列中移除
        conn.execute(
            "UPDATE providers SET in_failover_queue = 0 WHERE id = ?1 AND app_type = ?2",
            rusqlite::params![provider_id, app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        // 2. 清除该供应商的健康状态（退出队列后不再需要健康监控）
        conn.execute(
            "DELETE FROM provider_health WHERE provider_id = ?1 AND app_type = ?2",
            rusqlite::params![provider_id, app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        log::info!("已从故障转移队列移除供应商 {provider_id} ({app_type}), 并清除其健康状态");

        Ok(())
    }

    /// 重排故障转移队列。
    ///
    /// 队列顺序复用 providers.sort_index；调用方必须传入当前队列的完整 provider_id 列表。
    pub fn reorder_failover_queue(
        &self,
        app_type: &str,
        provider_ids: &[String],
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);

        if provider_ids.is_empty() {
            return Err(AppError::InvalidInput(
                "故障转移队列排序不能为空".to_string(),
            ));
        }

        let requested_ids: HashSet<&str> = provider_ids.iter().map(String::as_str).collect();
        if requested_ids.len() != provider_ids.len() {
            return Err(AppError::InvalidInput(
                "故障转移队列排序包含重复供应商".to_string(),
            ));
        }

        let current_ids = {
            let mut stmt = conn
                .prepare(
                    "SELECT id
                     FROM providers
                     WHERE app_type = ?1 AND in_failover_queue = 1",
                )
                .map_err(|e| AppError::Database(e.to_string()))?;

            let rows = stmt
                .query_map([app_type], |row| row.get::<_, String>(0))
                .map_err(|e| AppError::Database(e.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| AppError::Database(e.to_string()))?;
            rows
        };

        let current_ids_set: HashSet<&str> = current_ids.iter().map(String::as_str).collect();
        if current_ids_set != requested_ids {
            return Err(AppError::InvalidInput(
                "故障转移队列已变化，请刷新后重试".to_string(),
            ));
        }

        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        for (index, provider_id) in provider_ids.iter().enumerate() {
            let updated = tx
                .execute(
                    "UPDATE providers
                     SET sort_index = ?1
                     WHERE id = ?2 AND app_type = ?3 AND in_failover_queue = 1",
                    rusqlite::params![index, provider_id, app_type],
                )
                .map_err(|e| AppError::Database(e.to_string()))?;

            if updated != 1 {
                return Err(AppError::InvalidInput(format!(
                    "供应商 {provider_id} 不在故障转移队列中"
                )));
            }
        }

        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;

        Ok(())
    }

    /// 清空故障转移队列
    pub fn clear_failover_queue(&self, app_type: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);

        conn.execute(
            "UPDATE providers SET in_failover_queue = 0 WHERE app_type = ?1",
            [app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(())
    }

    /// 检查供应商是否在故障转移队列中
    pub fn is_in_failover_queue(
        &self,
        app_type: &str,
        provider_id: &str,
    ) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);

        let in_queue: bool = conn
            .query_row(
                "SELECT in_failover_queue FROM providers WHERE id = ?1 AND app_type = ?2",
                rusqlite::params![provider_id, app_type],
                |row| row.get(0),
            )
            .unwrap_or(false);

        Ok(in_queue)
    }

    /// 获取可添加到故障转移队列的供应商（不在队列中的）
    pub fn get_available_providers_for_failover(
        &self,
        app_type: &str,
    ) -> Result<Vec<Provider>, AppError> {
        let all_providers = self.get_all_providers(app_type)?;

        let available: Vec<Provider> = all_providers
            .into_values()
            .filter(|p| !p.in_failover_queue)
            .collect();

        Ok(available)
    }
}

fn provider_load_limits_from_meta(meta_json: Option<String>) -> Option<ProviderLoadLimits> {
    meta_json
        .and_then(|meta| serde_json::from_str::<crate::provider::ProviderMeta>(&meta).ok())
        .and_then(|meta| meta.load_limits)
        .filter(|limits| limits.has_limits())
}
