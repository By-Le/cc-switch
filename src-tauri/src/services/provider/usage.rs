//! Usage script execution
//!
//! Handles executing and formatting usage query results.

use crate::app_config::AppType;
use crate::error::AppError;
use crate::provider::{UsageData, UsageResult, UsageScript};
use crate::settings;
use crate::store::AppState;
use crate::usage_script;

/// Execute usage script and format result (private helper method)
pub(crate) async fn execute_and_format_usage_result(
    script_code: &str,
    api_key: &str,
    base_url: &str,
    timeout: u64,
    access_token: Option<&str>,
    user_id: Option<&str>,
    template_type: Option<&str>,
) -> Result<UsageResult, AppError> {
    match usage_script::execute_usage_script(
        script_code,
        api_key,
        base_url,
        timeout,
        access_token,
        user_id,
        template_type,
    )
    .await
    {
        Ok(data) => {
            let usage_list: Vec<UsageData> = if data.is_array() {
                serde_json::from_value(data).map_err(|e| {
                    AppError::localized(
                        "usage_script.data_format_error",
                        format!("数据格式错误: {e}"),
                        format!("Data format error: {e}"),
                    )
                })?
            } else {
                let single: UsageData = serde_json::from_value(data).map_err(|e| {
                    AppError::localized(
                        "usage_script.data_format_error",
                        format!("数据格式错误: {e}"),
                        format!("Data format error: {e}"),
                    )
                })?;
                vec![single]
            };

            Ok(UsageResult {
                success: true,
                data: Some(usage_list),
                error: None,
            })
        }
        Err(err) => {
            let lang = settings::get_settings()
                .language
                .unwrap_or_else(|| "zh".to_string());

            let msg = match err {
                AppError::Localized { zh, en, .. } => {
                    if lang == "en" {
                        en
                    } else {
                        zh
                    }
                }
                other => other.to_string(),
            };

            Ok(UsageResult {
                success: false,
                data: None,
                error: Some(msg),
            })
        }
    }
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_base_url(base_url: String) -> String {
    base_url.trim_end_matches('/').to_string()
}

/// Resolve credentials for JS usage scripts.
///
/// Only the `general` template inherits provider credentials. Custom/New API
/// templates must provide their own values explicitly.
fn resolve_usage_script_credentials(
    app_type: &AppType,
    provider: &crate::provider::Provider,
    usage_script: &UsageScript,
) -> (String, String) {
    let api_key = non_empty(usage_script.api_key.as_deref()).unwrap_or_default();
    let base_url = non_empty(usage_script.base_url.as_deref())
        .map(normalize_base_url)
        .unwrap_or_default();

    if usage_script.template_type.as_deref() != Some("general") {
        return (api_key, base_url);
    }

    let (provider_base_url, provider_api_key) = provider.resolve_usage_credentials(app_type);
    let api_key = if api_key.is_empty() {
        provider_api_key
    } else {
        api_key
    };
    let base_url = if base_url.is_empty() {
        provider_base_url
    } else {
        base_url
    };

    (api_key, base_url)
}

/// Query provider usage (using saved script configuration)
pub async fn query_usage(
    state: &AppState,
    app_type: AppType,
    provider_id: &str,
) -> Result<UsageResult, AppError> {
    let (script_code, timeout, api_key, base_url, access_token, user_id, template_type) = {
        let providers = state.db.get_all_providers(app_type.as_str())?;
        let provider = providers.get(provider_id).ok_or_else(|| {
            AppError::localized(
                "provider.not_found",
                format!("供应商不存在: {provider_id}"),
                format!("Provider not found: {provider_id}"),
            )
        })?;

        let usage_script = provider
            .meta
            .as_ref()
            .and_then(|m| m.usage_script.as_ref())
            .ok_or_else(|| {
                AppError::localized(
                    "provider.usage.script.missing",
                    "未配置用量查询脚本",
                    "Usage script is not configured",
                )
            })?;
        if !usage_script.enabled {
            return Err(AppError::localized(
                "provider.usage.disabled",
                "用量查询未启用",
                "Usage query is disabled",
            ));
        }

        let (api_key, base_url) =
            resolve_usage_script_credentials(&app_type, provider, usage_script);

        (
            usage_script.code.clone(),
            usage_script.timeout.unwrap_or(10),
            api_key,
            base_url,
            usage_script.access_token.clone(),
            usage_script.user_id.clone(),
            usage_script.template_type.clone(),
        )
    };

    execute_and_format_usage_result(
        &script_code,
        &api_key,
        &base_url,
        timeout,
        access_token.as_deref(),
        user_id.as_deref(),
        template_type.as_deref(),
    )
    .await
}

/// Test usage script (using temporary script content, not saved)
#[allow(clippy::too_many_arguments)]
pub async fn test_usage_script(
    _state: &AppState,
    _app_type: AppType,
    _provider_id: &str,
    script_code: &str,
    timeout: u64,
    api_key: Option<&str>,
    base_url: Option<&str>,
    access_token: Option<&str>,
    user_id: Option<&str>,
    template_type: Option<&str>,
) -> Result<UsageResult, AppError> {
    let api_key = non_empty(api_key).unwrap_or_default();
    let base_url = non_empty(base_url).map(normalize_base_url).unwrap_or_default();

    execute_and_format_usage_result(
        script_code,
        &api_key,
        &base_url,
        timeout,
        access_token,
        user_id,
        template_type,
    )
    .await
}

/// Validate UsageScript configuration (boundary checks)
pub(crate) fn validate_usage_script(script: &UsageScript) -> Result<(), AppError> {
    // Validate auto query interval (0-1440 minutes, max 24 hours)
    if let Some(interval) = script.auto_query_interval {
        if interval > 1440 {
            return Err(AppError::localized(
                "usage_script.interval_too_large",
                format!("自动查询间隔不能超过 1440 分钟（24小时），当前值: {interval}"),
                format!(
                    "Auto query interval cannot exceed 1440 minutes (24 hours), current: {interval}"
                ),
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{normalize_base_url, resolve_usage_script_credentials};
    use crate::app_config::AppType;
    use crate::provider::{Provider, UsageScript};
    use serde_json::json;

    fn usage_script(api_key: Option<&str>, base_url: Option<&str>) -> UsageScript {
        UsageScript {
            enabled: true,
            language: "javascript".to_string(),
            code: String::new(),
            timeout: Some(10),
            api_key: api_key.map(str::to_string),
            base_url: base_url.map(str::to_string),
            access_token: None,
            user_id: None,
            template_type: Some("general".to_string()),
            auto_query_interval: None,
            coding_plan_provider: None,
        }
    }

    #[test]
    fn general_usage_script_credentials_fall_back_to_provider_config() {
        let provider = Provider::with_id(
            "codex-provider".to_string(),
            "Codex Provider".to_string(),
            json!({
                "auth": { "OPENAI_API_KEY": "sk-codex" },
                "config": "model_provider = \"custom\"\n\
                           [model_providers.custom]\n\
                           base_url = \"https://codex.example.com/v1/\"\n",
            }),
            None,
        );
        let script = usage_script(None, None);

        let (api_key, base_url) =
            resolve_usage_script_credentials(&AppType::Codex, &provider, &script);

        assert_eq!(api_key, "sk-codex");
        assert_eq!(base_url, "https://codex.example.com/v1");
    }

    #[test]
    fn non_general_usage_script_does_not_fall_back_to_provider_config() {
        let provider = Provider::with_id(
            "claude-provider".to_string(),
            "Claude Provider".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://provider.example.com/v1",
                    "ANTHROPIC_AUTH_TOKEN": "sk-provider"
                }
            }),
            None,
        );
        let mut script = usage_script(None, None);
        script.template_type = Some("custom".to_string());

        let (api_key, base_url) =
            resolve_usage_script_credentials(&AppType::Claude, &provider, &script);

        assert_eq!(api_key, "");
        assert_eq!(base_url, "");
    }

    #[test]
    fn blank_usage_script_credentials_fall_back_to_provider_config() {
        let provider = Provider::with_id(
            "claude-provider".to_string(),
            "Claude Provider".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://claude.example.com/v1/",
                    "ANTHROPIC_AUTH_TOKEN": "sk-claude"
                }
            }),
            None,
        );
        let script = usage_script(Some("  "), Some(""));

        let (api_key, base_url) =
            resolve_usage_script_credentials(&AppType::Claude, &provider, &script);

        assert_eq!(api_key, "sk-claude");
        assert_eq!(base_url, "https://claude.example.com/v1");
    }

    #[test]
    fn usage_script_credentials_override_provider_config() {
        let provider = Provider::with_id(
            "claude-provider".to_string(),
            "Claude Provider".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://provider.example.com/v1",
                    "ANTHROPIC_AUTH_TOKEN": "sk-provider"
                }
            }),
            None,
        );
        let script = usage_script(Some("sk-script"), Some("https://script.example.com/api/"));

        let (api_key, base_url) =
            resolve_usage_script_credentials(&AppType::Claude, &provider, &script);

        assert_eq!(api_key, "sk-script");
        assert_eq!(base_url, "https://script.example.com/api");
    }

    #[test]
    fn base_url_normalization_trims_trailing_slashes() {
        assert_eq!(
            normalize_base_url("https://explicit.example.com/v1///".to_string()),
            "https://explicit.example.com/v1"
        );
    }
}
