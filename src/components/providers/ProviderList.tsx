import { CSS } from "@dnd-kit/utilities";
import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Provider } from "@/types";
import {
  extractCodexBaseUrl,
  extractCodexExperimentalBearerToken,
  extractCodexModelName,
} from "@/utils/providerConfigUtils";
import type { ActiveTarget } from "@/types/proxy";
import type { AppId } from "@/lib/api";
import {
  getStreamCheckConfig,
  type ProviderStreamCheckResult,
  type StreamCheckConfig,
} from "@/lib/api/model-test";
import { providersApi } from "@/lib/api/providers";
import { useDragSort } from "@/hooks/useDragSort";
import {
  useOpenClawLiveProviderIds,
  useOpenClawDefaultModel,
} from "@/hooks/useOpenClaw";
import {
  useHermesLiveProviderIds,
  useHermesModelConfig,
} from "@/hooks/useHermes";
import { useStreamCheck } from "@/hooks/useStreamCheck";
import { ProviderCard } from "@/components/providers/ProviderCard";
import { ProviderEmptyState } from "@/components/providers/ProviderEmptyState";
import {
  useAutoFailoverEnabled,
  useFailoverQueue,
  useAddToFailoverQueue,
  useRemoveFromFailoverQueue,
} from "@/lib/query/failover";
import {
  useCurrentOmoProviderId,
  useCurrentOmoSlimProviderId,
} from "@/lib/query/omo";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { settingsApi } from "@/lib/api/settings";
import {
  fetchModelsForConfig,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type TestModelOption = {
  value: string;
  label?: string;
};

interface ModelFetchParams {
  baseUrl: string;
  apiKey: string;
  isFullUrl?: boolean;
  customUserAgent?: string;
}
import { isTextEditableTarget } from "@/utils/domUtils";

interface ProviderListProps {
  providers: Record<string, Provider>;
  currentProviderId: string;
  appId: AppId;
  onSwitch: (provider: Provider) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onRemoveFromConfig?: (provider: Provider) => void;
  onDisableOmo?: () => void;
  onDisableOmoSlim?: () => void;
  onDuplicate: (provider: Provider) => void;
  onConfigureUsage?: (provider: Provider) => void;
  onOpenWebsite: (url: string) => void;
  onOpenTerminal?: (provider: Provider) => void;
  onCreate?: () => void;
  isLoading?: boolean;
  isProxyRunning?: boolean; // 代理服务运行状态
  isProxyTakeover?: boolean; // 代理接管模式（Live配置已被接管）
  activeProviderId?: string; // 代理当前实际使用的供应商 ID（用于故障转移模式下标注绿色边框）
  activeProviderTargets?: ActiveTarget[];
  onSetAsDefault?: (provider: Provider) => void; // OpenClaw: set as default model
}

interface ModelTestDialogState {
  provider: Provider;
  suggestedModel: string;
  modelInput: string;
  options: TestModelOption[];
  isOptionsExpanded: boolean;
  isFetchingModels: boolean;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function addUniqueModelOption(
  options: TestModelOption[],
  seen: Set<string>,
  value?: string,
  label?: string,
) {
  const normalized = value?.trim();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  options.push({ value: normalized, label: label?.trim() || undefined });
}

function mergeModelOptions(
  baseOptions: TestModelOption[],
  fetchedOptions: TestModelOption[],
): TestModelOption[] {
  const merged: TestModelOption[] = [];
  const seen = new Set<string>();
  for (const option of [...baseOptions, ...fetchedOptions]) {
    addUniqueModelOption(merged, seen, option.value, option.label);
  }
  return merged;
}

function fetchedModelsToOptions(models: FetchedModel[]): TestModelOption[] {
  const options: TestModelOption[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    addUniqueModelOption(options, seen, model.id);
  }
  return options;
}

function getModelFetchParams(
  appId: AppId,
  provider: Provider,
): ModelFetchParams | null {
  const config = provider.settingsConfig ?? {};
  const env = config.env as Record<string, unknown> | undefined;

  if (appId === "codex") {
    const configText = stringValue(config.config);
    const auth = config.auth as { OPENAI_API_KEY?: unknown } | undefined;
    const apiKey =
      stringValue(auth?.OPENAI_API_KEY) ||
      stringValue(extractCodexExperimentalBearerToken(configText));
    return {
      baseUrl: stringValue(extractCodexBaseUrl(configText)),
      apiKey,
      isFullUrl: provider.meta?.isFullUrl,
      customUserAgent: provider.meta?.customUserAgent,
    };
  }

  if (appId === "claude" || appId === "claude-desktop") {
    return {
      baseUrl: stringValue(env?.ANTHROPIC_BASE_URL),
      apiKey:
        stringValue(env?.ANTHROPIC_AUTH_TOKEN) ||
        stringValue(env?.ANTHROPIC_API_KEY),
      isFullUrl: provider.meta?.isFullUrl,
      customUserAgent: provider.meta?.customUserAgent,
    };
  }

  if (appId === "gemini") {
    return {
      baseUrl: stringValue(env?.GOOGLE_GEMINI_BASE_URL),
      apiKey:
        stringValue(env?.GEMINI_API_KEY) || stringValue(env?.GOOGLE_API_KEY),
    };
  }

  if (appId === "opencode" || appId === "openclaw" || appId === "hermes") {
    return {
      baseUrl: stringValue(config.baseUrl) || stringValue(config.base_url),
      apiKey: stringValue(config.apiKey) || stringValue(config.api_key),
    };
  }

  return null;
}

export function ProviderList({
  providers,
  currentProviderId,
  appId,
  onSwitch,
  onEdit,
  onDelete,
  onRemoveFromConfig,
  onDisableOmo,
  onDisableOmoSlim,
  onDuplicate,
  onConfigureUsage,
  onOpenWebsite,
  onOpenTerminal,
  onCreate,
  isLoading = false,
  isProxyRunning = false,
  isProxyTakeover = false,
  activeProviderId,
  activeProviderTargets = [],
  onSetAsDefault,
}: ProviderListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { checkProvider, isChecking, lastResults = {} } = useStreamCheck(appId);
  const { sortedProviders, sensors, handleDragEnd } = useDragSort(
    providers,
    appId,
  );

  const { data: opencodeLiveIds } = useQuery({
    queryKey: ["opencodeLiveProviderIds"],
    queryFn: () => providersApi.getOpenCodeLiveProviderIds(),
    enabled: appId === "opencode",
  });

  // OpenClaw: 查询 live 配置中的供应商 ID 列表，用于判断 isInConfig
  const { data: openclawLiveIds } = useOpenClawLiveProviderIds(
    appId === "openclaw",
  );

  // Hermes: 查询 live 配置中的供应商 ID 列表，用于判断 isInConfig
  const { data: hermesLiveIds } = useHermesLiveProviderIds(appId === "hermes");

  // Hermes: 读取当前 model.provider，用于判断哪个供应商是"当前激活"（高亮）
  const { data: hermesModelConfig } = useHermesModelConfig(appId === "hermes");
  const hermesCurrentProviderId = hermesModelConfig?.provider;

  // 判断供应商是否已添加到配置（累加模式应用：OpenCode/OpenClaw/Hermes）
  const isProviderInConfig = useCallback(
    (providerId: string): boolean => {
      if (appId === "opencode") {
        return opencodeLiveIds?.includes(providerId) ?? false;
      }
      if (appId === "openclaw") {
        return openclawLiveIds?.includes(providerId) ?? false;
      }
      if (appId === "hermes") {
        return hermesLiveIds?.includes(providerId) ?? false;
      }
      return true; // 其他应用始终返回 true
    },
    [appId, opencodeLiveIds, openclawLiveIds, hermesLiveIds],
  );

  // OpenClaw: query default model to determine which provider is default
  const { data: openclawDefaultModel } = useOpenClawDefaultModel(
    appId === "openclaw",
  );

  const isProviderDefaultModel = useCallback(
    (providerId: string): boolean => {
      if (appId !== "openclaw" || !openclawDefaultModel?.primary) return false;
      return openclawDefaultModel.primary.startsWith(providerId + "/");
    },
    [appId, openclawDefaultModel],
  );

  // 故障转移相关
  const { data: isAutoFailoverEnabled } = useAutoFailoverEnabled(appId);
  const { data: failoverQueue } = useFailoverQueue(appId);
  const addToQueue = useAddToFailoverQueue();
  const removeFromQueue = useRemoveFromFailoverQueue();
  const [showFailoverEnabledOnly, setShowFailoverEnabledOnly] = useState(false);

  const isFailoverModeActive =
    isProxyTakeover === true && isAutoFailoverEnabled === true;

  useEffect(() => {
    if (!isFailoverModeActive) {
      setShowFailoverEnabledOnly(false);
    }
  }, [isFailoverModeActive]);

  const isOpenCode = appId === "opencode";
  const { data: currentOmoId } = useCurrentOmoProviderId(isOpenCode);
  const { data: currentOmoSlimId } = useCurrentOmoSlimProviderId(isOpenCode);

  const getFailoverPriority = useCallback(
    (providerId: string): number | undefined => {
      if (!isFailoverModeActive || !failoverQueue) return undefined;
      const index = failoverQueue.findIndex(
        (item) => item.providerId === providerId,
      );
      return index >= 0 ? index + 1 : undefined;
    },
    [isFailoverModeActive, failoverQueue],
  );

  const isInFailoverQueue = useCallback(
    (providerId: string): boolean => {
      if (!isFailoverModeActive || !failoverQueue) return false;
      return failoverQueue.some(
        (item) => item.providerId === providerId && item.enabled !== false,
      );
    },
    [isFailoverModeActive, failoverQueue],
  );

  const handleToggleFailover = useCallback(
    (providerId: string, enabled: boolean) => {
      if (enabled) {
        addToQueue.mutate({ appType: appId, providerId });
      } else {
        removeFromQueue.mutate({ appType: appId, providerId });
      }
    },
    [appId, addToQueue, removeFromQueue],
  );

  const [searchTerm, setSearchTerm] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showStreamCheckConfirm, setShowStreamCheckConfirm] = useState(false);
  const [pendingTestProvider, setPendingTestProvider] =
    useState<Provider | null>(null);
  const [activeSessionsDialog, setActiveSessionsDialog] = useState<{
    providerName: string;
    sessionIds: string[];
  } | null>(null);
  const [modelTestDialog, setModelTestDialog] =
    useState<ModelTestDialogState | null>(null);
  const modelFetchRequestRef = useRef(0);
  const { data: claudeDesktopStatus } = useQuery({
    queryKey: ["claudeDesktopStatus"],
    queryFn: () => providersApi.getClaudeDesktopStatus(),
    enabled: appId === "claude-desktop",
    refetchInterval: appId === "claude-desktop" ? 5000 : false,
  });

  // Query settings for streamCheckConfirmed flag
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
  });

  const { data: streamCheckConfig } = useQuery({
    queryKey: ["streamCheckConfig"],
    queryFn: () => getStreamCheckConfig(),
  });

  const getGlobalTestModel = useCallback(
    (config: StreamCheckConfig | undefined): string | undefined => {
      if (!config) return undefined;
      const value =
        appId === "claude" || appId === "claude-desktop"
          ? config.claudeModel
          : appId === "codex"
            ? config.codexModel
            : appId === "gemini"
              ? config.geminiModel
              : undefined;
      return value?.trim() || undefined;
    },
    [appId],
  );

  const getProviderRuntimeModel = useCallback(
    (provider: Provider): string | undefined => {
      const config = provider.settingsConfig ?? {};
      if (appId === "claude" || appId === "claude-desktop") {
        const env = config.env as Record<string, unknown> | undefined;
        const value = env?.ANTHROPIC_MODEL;
        return typeof value === "string"
          ? value.trim() || undefined
          : undefined;
      }
      if (appId === "gemini") {
        const env = config.env as Record<string, unknown> | undefined;
        const value = env?.GEMINI_MODEL;
        return typeof value === "string"
          ? value.trim() || undefined
          : undefined;
      }
      if (appId === "codex") {
        return extractCodexModelName(config.config);
      }
      if (appId === "opencode") {
        const models = config.models as Record<string, unknown> | undefined;
        return models ? Object.keys(models)[0] : undefined;
      }
      if (appId === "openclaw") {
        const models = Array.isArray(config.models) ? config.models : [];
        const first = models[0] as { id?: unknown } | undefined;
        return typeof first?.id === "string"
          ? first.id.trim() || undefined
          : undefined;
      }
      if (appId === "hermes") {
        const model = config.model as { default?: unknown } | undefined;
        if (typeof model?.default === "string") {
          const trimmed = model.default.trim();
          if (trimmed) return trimmed;
        }
        const models = Array.isArray(config.models) ? config.models : [];
        const first = models[0] as { id?: unknown } | undefined;
        return typeof first?.id === "string"
          ? first.id.trim() || undefined
          : undefined;
      }
      return undefined;
    },
    [appId],
  );

  const getProviderTestModelOptions = useCallback(
    (provider: Provider): TestModelOption[] => {
      const config = provider.settingsConfig ?? {};
      const options: TestModelOption[] = [];
      const seen = new Set<string>();
      const pushOption = (value?: string, label?: string) => {
        const normalized = value?.trim();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        options.push({ value: normalized, label: label?.trim() || undefined });
      };

      pushOption(provider.meta?.testConfig?.testModel);
      pushOption(getGlobalTestModel(streamCheckConfig));
      pushOption(getProviderRuntimeModel(provider));

      if (appId === "codex") {
        const catalogModels = Array.isArray(config.modelCatalog?.models)
          ? (config.modelCatalog.models as Array<Record<string, unknown>>)
          : [];
        for (const item of catalogModels) {
          pushOption(
            typeof item.model === "string" ? item.model : undefined,
            typeof item.displayName === "string" ? item.displayName : undefined,
          );
        }
      } else if (appId === "opencode") {
        const models = config.models as
          | Record<string, { name?: string }>
          | undefined;
        if (models) {
          for (const [id, model] of Object.entries(models)) {
            pushOption(id, model?.name);
          }
        }
      } else if (appId === "openclaw" || appId === "hermes") {
        const models = Array.isArray(config.models) ? config.models : [];
        for (const item of models as Array<{
          id?: unknown;
          name?: unknown;
          alias?: unknown;
        }>) {
          pushOption(
            typeof item.id === "string" ? item.id : undefined,
            typeof item.name === "string"
              ? item.name
              : typeof item.alias === "string"
                ? item.alias
                : undefined,
          );
        }
      } else if (appId === "claude" || appId === "claude-desktop") {
        pushOption(config.env?.ANTHROPIC_MODEL as string | undefined);
      } else if (appId === "gemini") {
        pushOption(config.env?.GEMINI_MODEL as string | undefined);
      }

      return options;
    },
    [appId, getGlobalTestModel, getProviderRuntimeModel, streamCheckConfig],
  );

  const openModelDialog = useCallback(
    (provider: Provider) => {
      const options = getProviderTestModelOptions(provider);
      const suggestedModel = options[0]?.value ?? "";
      setModelTestDialog({
        provider,
        suggestedModel,
        modelInput: suggestedModel,
        options,
        isOptionsExpanded: options.length > 0,
        isFetchingModels: false,
      });
    },
    [getProviderTestModelOptions],
  );

  const handleTest = useCallback(
    (provider: Provider) => {
      if (!settings?.streamCheckConfirmed) {
        setPendingTestProvider(provider);
        setShowStreamCheckConfirm(true);
        return;
      }

      openModelDialog(provider);
    },
    [openModelDialog, settings?.streamCheckConfirmed],
  );

  const handleStreamCheckConfirm = useCallback(async () => {
    setShowStreamCheckConfirm(false);

    try {
      const currentSettings = settings ?? (await settingsApi.get());
      const { webdavSync: _, s3Sync: _s3Sync, ...rest } = currentSettings;
      await settingsApi.save({ ...rest, streamCheckConfirmed: true });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (error) {
      console.error("Failed to save stream check confirmed:", error);
    }

    if (pendingTestProvider) {
      openModelDialog(pendingTestProvider);
      setPendingTestProvider(null);
    }
  }, [openModelDialog, pendingTestProvider, queryClient, settings]);

  const handleRunModelTest = useCallback(async () => {
    if (!modelTestDialog) {
      return;
    }

    const modelOverride = modelTestDialog.modelInput.trim() || undefined;
    const result = await checkProvider(
      modelTestDialog.provider.id,
      modelTestDialog.provider.name,
      modelOverride,
    );

    if (result) {
      setModelTestDialog(null);
    }
  }, [checkProvider, modelTestDialog]);

  const handleFetchTestModels = useCallback(() => {
    if (!modelTestDialog) {
      return;
    }

    const requestId = ++modelFetchRequestRef.current;
    const providerId = modelTestDialog.provider.id;
    const params = getModelFetchParams(appId, modelTestDialog.provider);
    if (!params) {
      showFetchModelsError(null, t, {
        hasApiKey: false,
        hasBaseUrl: false,
      });
      return;
    }

    if (!params.baseUrl || !params.apiKey) {
      showFetchModelsError(null, t, {
        hasApiKey: !!params.apiKey,
        hasBaseUrl: !!params.baseUrl,
      });
      return;
    }

    setModelTestDialog((current) =>
      current ? { ...current, isFetchingModels: true } : current,
    );

    fetchModelsForConfig(
      params.baseUrl,
      params.apiKey,
      params.isFullUrl,
      undefined,
      params.customUserAgent,
    )
      .then((models) => {
        const fetchedOptions = fetchedModelsToOptions(models);
        if (modelFetchRequestRef.current !== requestId) {
          return;
        }
        setModelTestDialog((current) => {
          if (!current || current.provider.id !== providerId) return current;
          const mergedOptions = mergeModelOptions(
            current.options,
            fetchedOptions,
          );
          const nextModelInput =
            current.modelInput.trim() || fetchedOptions[0]?.value || "";
          return {
            ...current,
            modelInput: nextModelInput,
            options: mergedOptions,
            isOptionsExpanded: mergedOptions.length > 0,
          };
        });

        if (models.length === 0) {
          toast.info(t("providerForm.fetchModelsEmpty"));
        } else {
          toast.success(
            t("providerForm.fetchModelsSuccess", { count: models.length }),
          );
        }
      })
      .catch((err) => {
        console.warn("[ModelFetch] Failed:", err);
        showFetchModelsError(err, t);
      })
      .finally(() => {
        if (modelFetchRequestRef.current !== requestId) {
          return;
        }
        setModelTestDialog((current) =>
          current && current.provider.id === providerId
            ? { ...current, isFetchingModels: false }
            : current,
        );
      });
  }, [appId, modelTestDialog, t]);

  const handleSelectTestModel = useCallback((model: string) => {
    setModelTestDialog((current) =>
      current ? { ...current, modelInput: model } : current,
    );
  }, []);

  const currentTestModelOptions = useMemo(
    () => modelTestDialog?.options ?? [],
    [modelTestDialog?.options],
  );

  // Import current live config as default provider
  const importMutation = useMutation({
    mutationFn: async (): Promise<boolean> => {
      if (appId === "opencode") {
        const count = await providersApi.importOpenCodeFromLive();
        return count > 0;
      }
      if (appId === "openclaw") {
        const count = await providersApi.importOpenClawFromLive();
        return count > 0;
      }
      if (appId === "hermes") {
        const count = await providersApi.importHermesFromLive();
        return count > 0;
      }
      if (appId === "claude-desktop") {
        const count = await providersApi.importClaudeDesktopFromClaude();
        return count > 0;
      }
      return providersApi.importDefault(appId);
    },
    onSuccess: (imported) => {
      if (imported) {
        queryClient.invalidateQueries({ queryKey: ["providers", appId] });
        if (appId === "claude-desktop") {
          queryClient.invalidateQueries({ queryKey: ["claudeDesktopStatus"] });
        }
        toast.success(t("provider.importCurrentDescription"));
      } else {
        toast.info(t("provider.noProviders"));
      }
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "f") {
        // 正在输入框/可编辑区域中时不抢占 Ctrl+F（例如添加供应商表单里
        // ProviderPresetSelector 的搜索框），避免与其同名快捷键冲突。
        if (isTextEditableTarget(document.activeElement)) return;
        event.preventDefault();
        setIsSearchOpen(true);
        return;
      }

      if (key === "escape") {
        setIsSearchOpen(false);
      }
    };

    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (isSearchOpen) {
      const frame = requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [isSearchOpen]);

  const visibleProviders = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    return sortedProviders.filter((provider) => {
      if (showFailoverEnabledOnly && !isInFailoverQueue(provider.id)) {
        return false;
      }
      if (!keyword) return true;

      const fields = [provider.name, provider.notes, provider.websiteUrl];
      return fields.some((field) =>
        field?.toString().toLowerCase().includes(keyword),
      );
    });
  }, [isInFailoverQueue, searchTerm, showFailoverEnabledOnly, sortedProviders]);

  const activeSessionsByProvider = useMemo(() => {
    const map = new Map<string, { count: number; sessionIds: string[] }>();
    for (const target of activeProviderTargets) {
      if (target.app_type !== appId) continue;
      const sessionIds = target.session_ids ?? [];
      const count = Math.max(target.active_connections ?? 0, sessionIds.length);
      const existing = map.get(target.provider_id);
      if (existing) {
        existing.count += count;
        existing.sessionIds.push(...sessionIds);
      } else {
        map.set(target.provider_id, { count, sessionIds: [...sessionIds] });
      }
    }
    for (const value of map.values()) {
      value.sessionIds = Array.from(new Set(value.sessionIds)).sort();
    }
    return map;
  }, [activeProviderTargets, appId]);

  const claudeDesktopStatusMessages = useMemo(() => {
    if (appId !== "claude-desktop" || !claudeDesktopStatus) return [];

    const messages: string[] = [];
    if (!claudeDesktopStatus.supported) {
      messages.push(
        t("claudeDesktop.statusUnsupported", {
          defaultValue: "当前平台暂不支持 Claude Desktop 3P 配置写入。",
        }),
      );
      return messages;
    }

    if (claudeDesktopStatus.staleRawModels) {
      messages.push(
        t("claudeDesktop.statusStaleRawModels", {
          defaultValue:
            "Claude Desktop profile 中存在非 claude-* 模型名，新版 Claude Desktop 可能拒绝加载；重新切换当前供应商可修复。",
        }),
      );
    }
    if (claudeDesktopStatus.missingRouteMappings) {
      messages.push(
        t("claudeDesktop.statusMissingRouteMappings", {
          defaultValue:
            "当前供应商启用了模型映射，但没有有效路由；请编辑供应商并补全至少一个模型映射。",
        }),
      );
    }
    if (
      claudeDesktopStatus.mode === "proxy" &&
      !claudeDesktopStatus.gatewayTokenConfigured
    ) {
      messages.push(
        t("claudeDesktop.statusGatewayTokenMissing", {
          defaultValue:
            "当前本地路由 token 尚未生成；重新切换该供应商会写入新的本地 token。",
        }),
      );
    }

    const expected = claudeDesktopStatus.expectedBaseUrl?.replace(/\/+$/, "");
    const actual = claudeDesktopStatus.actualBaseUrl?.replace(/\/+$/, "");
    if (expected && actual && expected !== actual) {
      messages.push(
        t("claudeDesktop.statusBaseUrlMismatch", {
          expected,
          actual,
          defaultValue:
            "Claude Desktop profile 指向的地址与当前供应商不一致；当前为 {{actual}}，应为 {{expected}}。重新切换当前供应商可修复。",
        }),
      );
    }

    return messages;
  }, [appId, claudeDesktopStatus, t]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="w-full border border-dashed rounded-lg h-28 border-muted-foreground/40 bg-muted/40"
          />
        ))}
      </div>
    );
  }

  if (sortedProviders.length === 0) {
    return (
      <ProviderEmptyState
        appId={appId}
        onCreate={onCreate}
        onImport={() => importMutation.mutate()}
      />
    );
  }

  const renderProviderList = () => (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={visibleProviders.map((provider) => provider.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-3">
          {visibleProviders.map((provider) => {
            const isOmo = provider.category === "omo";
            const isOmoSlim = provider.category === "omo-slim";
            const isOmoCurrent = isOmo && provider.id === (currentOmoId || "");
            const isOmoSlimCurrent =
              isOmoSlim && provider.id === (currentOmoSlimId || "");
            const isHermesCurrent =
              appId === "hermes" && hermesCurrentProviderId === provider.id;
            const activeSessions = activeSessionsByProvider.get(provider.id);
            return (
              <SortableProviderCard
                key={provider.id}
                provider={provider}
                isCurrent={
                  isOmo
                    ? isOmoCurrent
                    : isOmoSlim
                      ? isOmoSlimCurrent
                      : appId === "hermes"
                        ? isHermesCurrent
                        : provider.id === currentProviderId
                }
                appId={appId}
                isInConfig={isProviderInConfig(provider.id)}
                isOmo={isOmo}
                isOmoSlim={isOmoSlim}
                onSwitch={onSwitch}
                onEdit={onEdit}
                onDelete={onDelete}
                onRemoveFromConfig={onRemoveFromConfig}
                onDisableOmo={onDisableOmo}
                onDisableOmoSlim={onDisableOmoSlim}
                onDuplicate={onDuplicate}
                onConfigureUsage={onConfigureUsage}
                onOpenWebsite={onOpenWebsite}
                onOpenTerminal={onOpenTerminal}
                onTest={handleTest}
                isTesting={isChecking(provider.id)}
                lastTestResult={lastResults[provider.id]}
                isProxyRunning={isProxyRunning}
                isProxyTakeover={isProxyTakeover}
                isAutoFailoverEnabled={isFailoverModeActive}
                failoverPriority={getFailoverPriority(provider.id)}
                isInFailoverQueue={isInFailoverQueue(provider.id)}
                onToggleFailover={(enabled) =>
                  handleToggleFailover(provider.id, enabled)
                }
                activeProviderId={activeProviderId}
                activeConnectionCount={activeSessions?.count ?? 0}
                onShowActiveSessions={() =>
                  setActiveSessionsDialog({
                    providerName: provider.name,
                    sessionIds: activeSessions?.sessionIds ?? [],
                  })
                }
                // OpenClaw: default model / Hermes: model.provider === provider.id
                isDefaultModel={
                  appId === "hermes"
                    ? isHermesCurrent
                    : isProviderDefaultModel(provider.id)
                }
                onSetAsDefault={
                  onSetAsDefault ? () => onSetAsDefault(provider) : undefined
                }
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );

  return (
    <div className="mt-4 space-y-4">
      {claudeDesktopStatusMessages.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {t("claudeDesktop.statusTitle", {
              defaultValue: "Claude Desktop 配置需要检查",
            })}
          </div>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed">
            {claudeDesktopStatusMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      <AnimatePresence>
        {isSearchOpen && (
          <motion.div
            key="provider-search"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="fixed left-1/2 top-[6.5rem] z-40 w-[min(90vw,26rem)] -translate-x-1/2 sm:right-6 sm:left-auto sm:translate-x-0"
          >
            <div className="p-4 space-y-3 border shadow-md rounded-2xl border-white/10 bg-background/95 shadow-black/20 backdrop-blur-md">
              <div className="relative flex items-center gap-2">
                <Search className="absolute w-4 h-4 -translate-y-1/2 pointer-events-none left-3 top-1/2 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder={t("provider.searchPlaceholder", {
                    defaultValue: "Search name, notes, or URL...",
                  })}
                  aria-label={t("provider.searchAriaLabel", {
                    defaultValue: "Search providers",
                  })}
                  className="pr-16 pl-9"
                />
                {searchTerm && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute text-xs -translate-y-1/2 right-11 top-1/2"
                    onClick={() => setSearchTerm("")}
                  >
                    {t("common.clear", { defaultValue: "Clear" })}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto"
                  onClick={() => setIsSearchOpen(false)}
                  aria-label={t("provider.searchCloseAriaLabel", {
                    defaultValue: "Close provider search",
                  })}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  {t("provider.searchScopeHint", {
                    defaultValue: "Matches provider name, notes, and URL.",
                  })}
                </span>
                <span>
                  {t("provider.searchCloseHint", {
                    defaultValue: "Press Esc to close",
                  })}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {isFailoverModeActive && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
          <span className="text-sm text-muted-foreground">
            {t("provider.showFailoverEnabledOnly", {
              defaultValue: "只显示启用",
            })}
          </span>
          <Switch
            checked={showFailoverEnabledOnly}
            onCheckedChange={setShowFailoverEnabledOnly}
            aria-label={t("provider.showFailoverEnabledOnly", {
              defaultValue: "只显示启用",
            })}
          />
        </div>
      )}

      {visibleProviders.length === 0 ? (
        <div className="px-6 py-8 text-sm text-center border border-dashed rounded-lg border-border text-muted-foreground">
          {showFailoverEnabledOnly && !searchTerm.trim()
            ? t("provider.noFailoverEnabledProviders", {
                defaultValue: "没有已启用的故障转移供应商。",
              })
            : t("provider.noSearchResults", {
                defaultValue: "No providers match your search.",
              })}
        </div>
      ) : (
        renderProviderList()
      )}

      <ConfirmDialog
        isOpen={showStreamCheckConfirm}
        variant="info"
        title={t("confirm.streamCheck.title")}
        message={t("confirm.streamCheck.message")}
        confirmText={t("confirm.streamCheck.confirm")}
        onConfirm={() => void handleStreamCheckConfirm()}
        onCancel={() => {
          setShowStreamCheckConfirm(false);
          setPendingTestProvider(null);
        }}
      />

      <Dialog
        open={activeSessionsDialog !== null}
        onOpenChange={(open) => {
          if (!open) setActiveSessionsDialog(null);
        }}
      >
        <DialogContent className="max-w-xl" zIndex="top">
          <DialogHeader>
            <DialogTitle>
              {t("provider.activeSessionsTitle", {
                defaultValue: "活跃会话",
              })}
            </DialogTitle>
            <DialogDescription>
              {activeSessionsDialog?.providerName ?? ""}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto px-6 py-4">
            {activeSessionsDialog?.sessionIds.length ? (
              activeSessionsDialog.sessionIds.map((sessionId) => (
                <div
                  key={sessionId}
                  className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs break-all"
                >
                  {sessionId}
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("provider.noActiveSessions", {
                  defaultValue: "暂无活跃会话 ID，当前连接可能来自无会话请求。",
                })}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setActiveSessionsDialog(null)}
            >
              {t("common.close", { defaultValue: "关闭" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={modelTestDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setModelTestDialog(null);
          }
        }}
      >
        <DialogContent className="max-w-[34rem]" zIndex="top">
          <DialogHeader className="items-start text-left">
            <DialogTitle>
              {t("streamCheck.selectModelTitle", {
                providerName: modelTestDialog?.provider.name ?? "",
                defaultValue: "选择测试模型",
              })}
            </DialogTitle>
            <DialogDescription className="max-w-none space-y-2 text-left leading-relaxed">
              <span className="block">
                {t("streamCheck.selectModelDescription", {
                  defaultValue:
                    "将发送一条真实流式模型请求。你可以临时指定本次要测试的模型，也可以保留下面的手动输入。",
                })}
              </span>
              {modelTestDialog?.suggestedModel ? (
                <span className="block">
                  {t("streamCheck.currentSuggestedModelWithValue", {
                    model: modelTestDialog.suggestedModel,
                    defaultValue: "当前建议模型：{{model}}",
                  })}
                </span>
              ) : (
                <span className="block">
                  {t("modelTest.emptyModelHint", {
                    defaultValue:
                      "留空时按当前供应商配置或全局默认测试模型执行。",
                  })}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-6 py-4">
            <Collapsible
              open={modelTestDialog?.isOptionsExpanded ?? false}
              onOpenChange={(open) =>
                setModelTestDialog((current) =>
                  current ? { ...current, isOptionsExpanded: open } : current,
                )
              }
              className="overflow-hidden rounded-lg border border-border-default bg-muted/10"
            >
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant={null}
                    size="sm"
                    className="h-7 max-w-full justify-start gap-1 px-0 text-sm font-medium text-foreground hover:opacity-70"
                  >
                    {modelTestDialog?.isOptionsExpanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0" />
                    )}
                    <span className="truncate">
                      {t("streamCheck.modelListLabel", {
                        defaultValue: "模型列表",
                      })}
                    </span>
                  </Button>
                </CollapsibleTrigger>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleFetchTestModels}
                  disabled={
                    modelTestDialog
                      ? isChecking(modelTestDialog.provider.id) ||
                        modelTestDialog.isFetchingModels
                      : true
                  }
                  className="h-7 gap-1"
                >
                  {modelTestDialog?.isFetchingModels ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {t("providerForm.fetchModels", {
                    defaultValue: "获取模型列表",
                  })}
                </Button>
              </div>
              <CollapsibleContent>
                {currentTestModelOptions.length > 0 ? (
                  <div className="max-h-48 space-y-1 overflow-y-auto border-t border-border-default p-2">
                    {currentTestModelOptions.map((option) => {
                      const active =
                        modelTestDialog?.modelInput.trim() === option.value;
                      const label = option.label ?? option.value;
                      const disabled = modelTestDialog
                        ? isChecking(modelTestDialog.provider.id)
                        : false;
                      return (
                        <div
                          key={option.value}
                          role="button"
                          tabIndex={disabled ? -1 : 0}
                          aria-label={label}
                          aria-disabled={disabled}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted",
                            active &&
                              "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
                            disabled && "cursor-not-allowed opacity-50",
                          )}
                          onClick={() => {
                            if (!disabled) handleSelectTestModel(option.value);
                          }}
                          onKeyDown={(event) => {
                            if (
                              disabled ||
                              (event.key !== "Enter" && event.key !== " ")
                            ) {
                              return;
                            }
                            event.preventDefault();
                            handleSelectTestModel(option.value);
                          }}
                        >
                          <div
                            aria-hidden="true"
                            className={cn(
                              "grid h-4 w-4 shrink-0 place-items-center rounded-sm border",
                              active
                                ? "border-blue-500 bg-blue-500 text-white"
                                : "border-border bg-background",
                            )}
                          >
                            {active ? <Check className="h-3 w-3" /> : null}
                          </div>
                          <span className="min-w-0 flex-1 break-all">
                            {label}
                          </span>
                          {option.label && option.label !== option.value ? (
                            <span className="max-w-[45%] truncate font-mono text-[11px] text-muted-foreground">
                              {option.value}
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="border-t border-border-default px-3 py-3 text-sm text-muted-foreground">
                    {t("streamCheck.noModelAvailable", {
                      defaultValue: "暂无",
                    })}
                  </p>
                )}
              </CollapsibleContent>
            </Collapsible>

            <div className="space-y-2">
              <Label htmlFor="provider-model-test-input">
                {t("streamCheck.testModelLabel", {
                  defaultValue: "测试模型",
                })}
              </Label>
              <Input
                id="provider-model-test-input"
                value={modelTestDialog?.modelInput ?? ""}
                onChange={(event) =>
                  setModelTestDialog((current) =>
                    current
                      ? { ...current, modelInput: event.target.value }
                      : current,
                  )
                }
                placeholder={t("streamCheck.testModelPlaceholder", {
                  defaultValue: "输入模型名，或从上方选择",
                })}
                disabled={
                  modelTestDialog
                    ? isChecking(modelTestDialog.provider.id)
                    : false
                }
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setModelTestDialog(null)}
              disabled={
                modelTestDialog
                  ? isChecking(modelTestDialog.provider.id)
                  : false
              }
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </Button>
            <Button
              type="button"
              onClick={() => void handleRunModelTest()}
              disabled={
                modelTestDialog ? isChecking(modelTestDialog.provider.id) : true
              }
            >
              {modelTestDialog && isChecking(modelTestDialog.provider.id)
                ? t("modelTest.testing", { defaultValue: "正在测试模型" })
                : t("streamCheck.startTest", {
                    defaultValue: "开始测试",
                  })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface SortableProviderCardProps {
  provider: Provider;
  isCurrent: boolean;
  appId: AppId;
  isInConfig: boolean;
  isOmo: boolean;
  isOmoSlim: boolean;
  onSwitch: (provider: Provider) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onRemoveFromConfig?: (provider: Provider) => void;
  onDisableOmo?: () => void;
  onDisableOmoSlim?: () => void;
  onDuplicate: (provider: Provider) => void;
  onConfigureUsage?: (provider: Provider) => void;
  onOpenWebsite: (url: string) => void;
  onOpenTerminal?: (provider: Provider) => void;
  onTest?: (provider: Provider) => void;
  isTesting: boolean;
  lastTestResult?: ProviderStreamCheckResult;
  isProxyRunning: boolean;
  isProxyTakeover: boolean;
  isAutoFailoverEnabled: boolean;
  failoverPriority?: number;
  isInFailoverQueue: boolean;
  onToggleFailover: (enabled: boolean) => void;
  activeProviderId?: string;
  activeConnectionCount?: number;
  onShowActiveSessions?: () => void;
  // OpenClaw: default model
  isDefaultModel?: boolean;
  onSetAsDefault?: () => void;
}

function SortableProviderCard({
  provider,
  isCurrent,
  appId,
  isInConfig,
  isOmo,
  isOmoSlim,
  onSwitch,
  onEdit,
  onDelete,
  onRemoveFromConfig,
  onDisableOmo,
  onDisableOmoSlim,
  onDuplicate,
  onConfigureUsage,
  onOpenWebsite,
  onOpenTerminal,
  onTest,
  isTesting,
  lastTestResult,
  isProxyRunning,
  isProxyTakeover,
  isAutoFailoverEnabled,
  failoverPriority,
  isInFailoverQueue,
  onToggleFailover,
  activeProviderId,
  activeConnectionCount,
  onShowActiveSessions,
  isDefaultModel,
  onSetAsDefault,
}: SortableProviderCardProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: provider.id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <ProviderCard
        provider={provider}
        isCurrent={isCurrent}
        appId={appId}
        isInConfig={isInConfig}
        isOmo={isOmo}
        isOmoSlim={isOmoSlim}
        onSwitch={onSwitch}
        onEdit={onEdit}
        onDelete={onDelete}
        onRemoveFromConfig={onRemoveFromConfig}
        onDisableOmo={onDisableOmo}
        onDisableOmoSlim={onDisableOmoSlim}
        onDuplicate={onDuplicate}
        onConfigureUsage={
          onConfigureUsage ? (item) => onConfigureUsage(item) : () => undefined
        }
        onOpenWebsite={onOpenWebsite}
        onOpenTerminal={onOpenTerminal}
        onTest={onTest}
        isTesting={isTesting}
        lastTestResult={lastTestResult}
        isProxyRunning={isProxyRunning}
        isProxyTakeover={isProxyTakeover}
        dragHandleProps={{
          attributes,
          listeners,
          isDragging,
        }}
        isAutoFailoverEnabled={isAutoFailoverEnabled}
        failoverPriority={failoverPriority}
        isInFailoverQueue={isInFailoverQueue}
        onToggleFailover={onToggleFailover}
        activeProviderId={activeProviderId}
        activeConnectionCount={activeConnectionCount}
        onShowActiveSessions={onShowActiveSessions}
        // OpenClaw: default model
        isDefaultModel={isDefaultModel}
        onSetAsDefault={onSetAsDefault}
      />
    </div>
  );
}
