import { describe, expect, it } from "vitest";
import {
  normalizeCodexCatalogModelsForSave,
  normalizeProviderLoadLimitsForSave,
  normalizeProviderTestConfigForSave,
} from "@/components/providers/forms/ProviderForm";

describe("ProviderForm Codex catalog helpers", () => {
  it("normalizes catalog rows and removes empty or duplicate models", () => {
    expect(
      normalizeCodexCatalogModelsForSave([
        { model: " deepseek-v4-flash ", displayName: " DeepSeek " },
        { model: "deepseek-v4-flash", displayName: "Duplicate" },
        { model: "", displayName: "Empty" },
        { model: "kimi-k2", contextWindow: "128000 tokens" },
      ]),
    ).toEqual([
      { model: "deepseek-v4-flash", displayName: "DeepSeek" },
      { model: "kimi-k2", contextWindow: 128000 },
    ]);
  });

  it("normalizes provider load limits for save", () => {
    expect(
      normalizeProviderLoadLimitsForSave({ maxConcurrent: 20, rpm: 100 }),
    ).toEqual({
      maxConcurrent: 20,
      rpm: 100,
    });
    expect(
      normalizeProviderLoadLimitsForSave({ maxConcurrent: 0 }),
    ).toBeUndefined();
    expect(normalizeProviderLoadLimitsForSave({})).toBeUndefined();
  });

  it("normalizes provider model test config for save", () => {
    expect(
      normalizeProviderTestConfigForSave({
        enabled: true,
        timeoutSecs: 45,
        degradedThresholdMs: 6000,
        maxRetries: 2,
        testModel: " gpt-5.5@low ",
        testPrompt: " Who are you? ",
      }),
    ).toEqual({
      enabled: true,
      timeoutSecs: 45,
      degradedThresholdMs: 6000,
      maxRetries: 2,
      testModel: "gpt-5.5@low",
      testPrompt: "Who are you?",
    });

    expect(
      normalizeProviderTestConfigForSave({
        enabled: true,
        testModel: " ",
        testPrompt: "",
      }),
    ).toEqual({ enabled: true });

    expect(
      normalizeProviderTestConfigForSave({
        enabled: false,
        testModel: "gpt-5.5@low",
      }),
    ).toBeUndefined();
  });
});
