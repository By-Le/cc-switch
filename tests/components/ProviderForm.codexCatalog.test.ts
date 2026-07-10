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

  it("preserves native-profile overrides (parallel tool calls + input modalities + base instructions)", () => {
    expect(
      normalizeCodexCatalogModelsForSave([
        {
          model: "MiniMax-M3",
          displayName: "MiniMax-M3",
          contextWindow: 1000000,
          supportsParallelToolCalls: true,
          inputModalities: ["text", "image"],
          baseInstructions:
            "  You are Codex, a coding agent based on MiniMax-M3.  ",
        },
        // false must be preserved (not dropped as falsy); empty modalities dropped;
        // empty/whitespace baseInstructions dropped
        {
          model: "mimo-v2.5-pro",
          supportsParallelToolCalls: false,
          inputModalities: [],
          baseInstructions: "   ",
        },
      ]),
    ).toEqual([
      {
        model: "MiniMax-M3",
        displayName: "MiniMax-M3",
        contextWindow: 1000000,
        supportsParallelToolCalls: true,
        inputModalities: ["text", "image"],
        baseInstructions: "You are Codex, a coding agent based on MiniMax-M3.",
      },
      { model: "mimo-v2.5-pro", supportsParallelToolCalls: false },
    ]);
  });
});
