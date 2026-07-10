import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { DeepLinkImportRequest } from "../../lib/api/deeplink";
import { decodeBase64Utf8 } from "../../lib/utils/base64";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const formatServerTarget = (spec: unknown): string | null => {
  if (!isRecord(spec)) return null;

  const command = typeof spec.command === "string" ? spec.command.trim() : "";
  const url = typeof spec.url === "string" ? spec.url.trim() : "";

  if (command) return `Command: ${command}`;
  if (url) return `URL: ${url}`;
  return null;
};

export function McpConfirmation({
  request,
}: {
  request: DeepLinkImportRequest;
}) {
  const { t } = useTranslation();

  const mcpServers = useMemo(() => {
    if (!request.config) return null;
    try {
      const decoded = decodeBase64Utf8(request.config);
      const parsed = JSON.parse(decoded);
      if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return {};
      return parsed.mcpServers;
    } catch (e) {
      console.error("Failed to parse MCP config:", e);
      return null;
    }
  }, [request.config]);

  const targetApps = request.apps?.split(",") || [];
  const serverCount = Object.keys(mcpServers || {}).length;

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">{t("deeplink.mcp.title")}</h3>

      <div>
        <label className="block text-sm font-medium text-muted-foreground">
          {t("deeplink.mcp.targetApps")}
        </label>
        <div className="mt-1 flex gap-2 flex-wrap">
          {targetApps.map((app) => (
            <span
              key={app}
              className="px-2 py-1 bg-primary/10 text-primary text-xs rounded capitalize"
            >
              {app.trim()}
            </span>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-muted-foreground">
          {t("deeplink.mcp.serverCount", { count: serverCount })}
        </label>
        <div className="mt-1 space-y-2 max-h-64 overflow-auto border rounded p-2 bg-muted/30">
          {mcpServers &&
            Object.entries(mcpServers).map(([id, spec]) => (
              <div key={id} className="p-2 bg-background rounded border">
                <div className="font-semibold text-sm">{id}</div>
                <div className="text-xs text-muted-foreground mt-1 font-mono truncate">
                  {formatServerTarget(spec) ??
                    t("deeplink.mcp.invalidServerSpec")}
                </div>
              </div>
            ))}
        </div>
      </div>

      {request.enabled && (
        <div className="text-yellow-600 dark:text-yellow-500 text-sm flex items-center gap-2">
          <span>⚠️</span>
          <span>{t("deeplink.mcp.enabledWarning")}</span>
        </div>
      )}
    </div>
  );
}
