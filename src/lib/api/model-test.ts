import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";

// ===== 模型测试类型 =====
// 注意：本检查会发送真实流式模型请求，但不触碰故障转移熔断器。

export type HealthStatus = "operational" | "degraded" | "failed";

export interface StreamCheckConfig {
  /** 单次测试超时（秒） */
  timeoutSecs: number;
  /** 超时类失败的最大重试次数 */
  maxRetries: number;
  /** 降级阈值（毫秒）：首字节响应超过该值判定为"较慢" */
  degradedThresholdMs: number;
  /** Claude 默认测试模型 */
  claudeModel: string;
  /** Codex 默认测试模型 */
  codexModel: string;
  /** Gemini 默认测试模型 */
  geminiModel: string;
  /** 默认测试提示词 */
  testPrompt: string;
}

export interface StreamCheckResult {
  status: HealthStatus;
  success: boolean;
  message: string;
  responseTimeMs?: number;
  httpStatus?: number;
  /** 本次测试实际使用的模型。 */
  modelUsed?: string;
  testedAt: number;
  retryCount: number;
  /** 细粒度错误分类，如 modelNotFound / quotaExceeded。 */
  errorCategory?: string;
}

export type ProviderStreamCheckResult = StreamCheckResult & {
  providerId: string;
};

// ===== 模型测试 API =====

/**
 * 模型测试（单个供应商）
 */
export async function streamCheckProvider(
  appType: AppId,
  providerId: string,
  modelOverride?: string,
): Promise<StreamCheckResult> {
  return invoke("stream_check_provider", {
    appType,
    providerId,
    modelOverride,
  });
}

/**
 * 批量流式健康检查
 */
export async function streamCheckAllProviders(
  appType: AppId,
  proxyTargetsOnly: boolean = false,
): Promise<Array<[string, StreamCheckResult]>> {
  return invoke("stream_check_all_providers", { appType, proxyTargetsOnly });
}

/**
 * 获取模型测试配置
 */
export async function getStreamCheckConfig(): Promise<StreamCheckConfig> {
  return invoke("get_stream_check_config");
}

/**
 * 保存模型测试配置
 */
export async function saveStreamCheckConfig(
  config: StreamCheckConfig,
): Promise<void> {
  return invoke("save_stream_check_config", { config });
}
