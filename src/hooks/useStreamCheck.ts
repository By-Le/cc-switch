import { useState, useCallback } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  streamCheckProvider,
  type ProviderStreamCheckResult,
  type StreamCheckResult,
} from "@/lib/api/model-test";
import type { AppId } from "@/lib/api";

export type LastStreamCheckResult = ProviderStreamCheckResult;

/**
 * 供应商真实模型测试。
 *
 * 会发送真实流式模型请求，但不重置故障转移熔断器；熔断器只由实际代理流量驱动。
 */
export function useStreamCheck(appId: AppId) {
  const { t } = useTranslation();
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());
  const [lastResults, setLastResults] = useState<
    Record<string, LastStreamCheckResult>
  >({});

  const checkProvider = useCallback(
    async (
      providerId: string,
      providerName: string,
      modelOverride?: string,
    ): Promise<StreamCheckResult | null> => {
      setCheckingIds((prev) => new Set(prev).add(providerId));

      try {
        const result = await streamCheckProvider(
          appId,
          providerId,
          modelOverride,
        );
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
        } else if (result.status === "degraded") {
          toast.warning(
            t("streamCheck.degraded", {
              providerName: providerName,
              responseTimeMs: result.responseTimeMs,
              defaultValue: `${providerName} 响应较慢 (${result.responseTimeMs}ms)`,
            }),
          );
        } else if (result.errorCategory === "modelNotFound") {
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
          const isProbeRejection =
            httpStatus != null &&
            ([401, 403, 400, 429].includes(httpStatus) || httpStatus >= 500);

          const toastFn = isProbeRejection ? toast.warning : toast.error;
          toastFn(
            t(isProbeRejection ? "streamCheck.rejected" : "streamCheck.failed", {
              providerName: providerName,
              message: result.message,
              defaultValue: `${providerName} 检查失败: ${result.message}`,
            }),
            {
              description,
              duration: 8000,
              closeButton: true,
            },
          );
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
    [appId, t],
  );

  const isChecking = useCallback(
    (providerId: string) => checkingIds.has(providerId),
    [checkingIds],
  );

  return { checkProvider, isChecking, lastResults };
}
