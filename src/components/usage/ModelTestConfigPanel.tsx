import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Save, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  getStreamCheckConfig,
  saveStreamCheckConfig,
  type StreamCheckConfig,
} from "@/lib/api/model-test";

const DEFAULT_TIMEOUT_SECS = 15;
const DEFAULT_MAX_RETRIES = 0;
const DEFAULT_DEGRADED_THRESHOLD_MS = 3000;

export function ModelTestConfigPanel() {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 使用字符串状态以支持完全清空数字输入框
  const [config, setConfig] = useState({
    timeoutSecs: String(DEFAULT_TIMEOUT_SECS),
    maxRetries: String(DEFAULT_MAX_RETRIES),
    degradedThresholdMs: String(DEFAULT_DEGRADED_THRESHOLD_MS),
    claudeModel: "claude-haiku-4-5-20251001",
    codexModel: "gpt-5.5@low",
    geminiModel: "gemini-3.5-flash",
    testPrompt: "Who are you?",
  });

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getStreamCheckConfig();
      setConfig({
        timeoutSecs: String(data.timeoutSecs),
        maxRetries: String(data.maxRetries),
        degradedThresholdMs: String(data.degradedThresholdMs),
        claudeModel: data.claudeModel,
        codexModel: data.codexModel,
        geminiModel: data.geminiModel,
        testPrompt: data.testPrompt || "Who are you?",
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave() {
    // 解析数字，空值使用默认值，0 是有效值
    const parseNum = (val: string, defaultVal: number) => {
      const n = parseInt(val);
      return isNaN(n) ? defaultVal : n;
    };
    try {
      setIsSaving(true);
      const parsed: StreamCheckConfig = {
        timeoutSecs: parseNum(config.timeoutSecs, DEFAULT_TIMEOUT_SECS),
        maxRetries: parseNum(config.maxRetries, DEFAULT_MAX_RETRIES),
        degradedThresholdMs: parseNum(
          config.degradedThresholdMs,
          DEFAULT_DEGRADED_THRESHOLD_MS,
        ),
        claudeModel: config.claudeModel,
        codexModel: config.codexModel,
        geminiModel: config.geminiModel,
        testPrompt: config.testPrompt || "Who are you?",
      };
      await saveStreamCheckConfig(parsed);
      toast.success(t("streamCheck.configSaved"), {
        closeButton: true,
      });
    } catch (e) {
      toast.error(t("streamCheck.configSaveFailed") + ": " + String(e));
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Alert>
        <AlertDescription>
          {t("streamCheck.modelTestNote", {
            defaultValue:
              "模型测试会发送一条真实流式请求，成功代表当前鉴权、接口和所选模型可用。",
          })}
        </AlertDescription>
      </Alert>

      <div className="space-y-4">
        <h4 className="text-sm font-medium text-muted-foreground">
          {t("streamCheck.testModels")}
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="claudeModel">{t("streamCheck.claudeModel")}</Label>
            <Input
              id="claudeModel"
              value={config.claudeModel}
              onChange={(e) =>
                setConfig({ ...config, claudeModel: e.target.value })
              }
              placeholder="claude-haiku-4-5-20251001"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="codexModel">{t("streamCheck.codexModel")}</Label>
            <Input
              id="codexModel"
              value={config.codexModel}
              onChange={(e) =>
                setConfig({ ...config, codexModel: e.target.value })
              }
              placeholder="gpt-5.5@low"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="geminiModel">{t("streamCheck.geminiModel")}</Label>
            <Input
              id="geminiModel"
              value={config.geminiModel}
              onChange={(e) =>
                setConfig({ ...config, geminiModel: e.target.value })
              }
              placeholder="gemini-3.5-flash"
            />
          </div>
        </div>
      </div>

      {/* 检查参数配置 */}
      <div className="space-y-4">
        <h4 className="text-sm font-medium text-muted-foreground">
          {t("streamCheck.checkParams")}
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="timeoutSecs">{t("streamCheck.timeout")}</Label>
            <Input
              id="timeoutSecs"
              type="number"
              min={10}
              max={120}
              value={config.timeoutSecs}
              onChange={(e) =>
                setConfig({ ...config, timeoutSecs: e.target.value })
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="maxRetries">{t("streamCheck.maxRetries")}</Label>
            <Input
              id="maxRetries"
              type="number"
              min={0}
              max={5}
              value={config.maxRetries}
              onChange={(e) =>
                setConfig({ ...config, maxRetries: e.target.value })
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="degradedThresholdMs">
              {t("streamCheck.degradedThreshold")}
            </Label>
            <Input
              id="degradedThresholdMs"
              type="number"
              min={1000}
              max={30000}
              step={1000}
              value={config.degradedThresholdMs}
              onChange={(e) =>
                setConfig({ ...config, degradedThresholdMs: e.target.value })
              }
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="testPrompt">{t("streamCheck.testPrompt")}</Label>
          <Textarea
            id="testPrompt"
            value={config.testPrompt}
            onChange={(e) =>
              setConfig({ ...config, testPrompt: e.target.value })
            }
            placeholder="Who are you?"
            rows={2}
            className="min-h-[60px]"
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("common.saving")}
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              {t("common.save")}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
