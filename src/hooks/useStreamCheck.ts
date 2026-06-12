import { useState, useCallback } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  streamCheckProvider,
  type ProviderStreamCheckResult,
  type StreamCheckResult,
} from "@/lib/api/model-test";
import type { AppId } from "@/lib/api";
import { useResetCircuitBreaker } from "@/lib/query/failover";

export type LastStreamCheckResult = ProviderStreamCheckResult;

export function useStreamCheck(appId: AppId) {
  const { t } = useTranslation();
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());
  const [lastResults, setLastResults] = useState<
    Record<string, LastStreamCheckResult>
  >({});
  const resetCircuitBreaker = useResetCircuitBreaker();

  const checkProvider = useCallback(
    async (
      providerId: string,
      providerName: string,
    ): Promise<StreamCheckResult | null> => {
      setCheckingIds((prev) => new Set(prev).add(providerId));

      try {
        const result = await streamCheckProvider(appId, providerId);
        setLastResults((prev) => ({
          ...prev,
          [providerId]: { ...result, providerId },
        }));

        if (result.status === "operational") {
          toast.success(
            t("streamCheck.operational", {
              providerName: providerName,
              responseTimeMs: result.responseTimeMs,
              defaultValue: `${providerName} 运行正常 (${result.responseTimeMs}ms)`,
            }),
            { closeButton: true },
          );

          // 测试通过后重置熔断器状态
          resetCircuitBreaker.mutate({ providerId, appType: appId });
        } else if (result.status === "degraded") {
          toast.warning(
            t("streamCheck.degraded", {
              providerName: providerName,
              responseTimeMs: result.responseTimeMs,
              defaultValue: `${providerName} 响应较慢 (${result.responseTimeMs}ms)`,
            }),
          );

          // 降级状态也重置熔断器，因为至少能通信
          resetCircuitBreaker.mutate({ providerId, appType: appId });
        } else if (result.errorCategory === "modelNotFound") {
          // 专门处理"模型不存在/已下架"：指向配置入口，比通用 404 文案更有指导性
          toast.error(
            t("streamCheck.modelNotFound", {
              providerName: providerName,
              model: result.modelUsed,
              defaultValue: `${providerName} 测试模型 ${result.modelUsed} 不存在或已下架`,
            }),
            {
              description: t("streamCheck.modelNotFoundHint", {
                defaultValue: "",
              }),
              duration: 10000,
              closeButton: true,
            },
          );
        } else if (result.errorCategory === "quotaExceeded") {
          toast.warning(
            t("streamCheck.quotaExceeded", {
              providerName: providerName,
              defaultValue: `${providerName} Coding Plan quota has been exceeded`,
            }),
            {
              description: t("streamCheck.quotaExceededHint", {
                defaultValue: "",
              }),
              duration: 10000,
              closeButton: true,
            },
          );
        } else {
          const httpStatus = result.httpStatus;
          const hintKey = httpStatus
            ? `streamCheck.httpHint.${httpStatus >= 500 ? "5xx" : httpStatus}`
            : null;
          const description =
            (hintKey ? t(hintKey, { defaultValue: "" }) : "") || undefined;

          const isTemporaryIssue =
            httpStatus != null && (httpStatus === 429 || httpStatus >= 500);
          // 401/403/400 = 检查被拒（供应商可能正常）
          const isProbeRejection =
            httpStatus != null && [401, 403, 400].includes(httpStatus);

          if (isTemporaryIssue) {
            toast.warning(
              t("streamCheck.temporary", {
                providerName: providerName,
                message: result.message,
                defaultValue: `${providerName} 临时不可用: ${result.message}`,
              }),
              { description, duration: 8000, closeButton: true },
            );
          } else if (isProbeRejection) {
            toast.warning(
              t("streamCheck.rejected", {
                providerName: providerName,
                message: result.message,
                defaultValue: `${providerName} 检查被拒: ${result.message}`,
              }),
              { description, duration: 8000, closeButton: true },
            );
          } else {
            toast.error(
              t("streamCheck.failed", {
                providerName: providerName,
                message: result.message,
                defaultValue: `${providerName} 检查失败: ${result.message}`,
              }),
              { description, duration: 8000, closeButton: true },
            );
          }
        }

        return result;
      } catch (e) {
        toast.error(
          t("streamCheck.error", {
            providerName: providerName,
            error: String(e),
            defaultValue: `${providerName} 检查出错: ${String(e)}`,
          }),
        );
        return null;
      } finally {
        setCheckingIds((prev) => {
          const next = new Set(prev);
          next.delete(providerId);
          return next;
        });
      }
    },
    [appId, t, resetCircuitBreaker],
  );

  const isChecking = useCallback(
    (providerId: string) => checkingIds.has(providerId),
    [checkingIds],
  );

  return { checkProvider, isChecking, lastResults };
}
