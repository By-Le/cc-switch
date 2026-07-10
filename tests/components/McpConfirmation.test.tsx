import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpConfirmation } from "@/components/deeplink/McpConfirmation";
import type { DeepLinkImportRequest } from "@/lib/api/deeplink";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

const encodeConfig = (value: unknown) =>
  btoa(unescape(encodeURIComponent(JSON.stringify(value))));

const requestFor = (config: unknown): DeepLinkImportRequest => ({
  version: "1",
  resource: "mcp",
  config: encodeConfig(config),
  apps: "claude,codex",
});

describe("McpConfirmation", () => {
  it("does not crash when server specs are malformed", () => {
    render(
      <McpConfirmation
        request={requestFor({
          mcpServers: {
            valid: { command: "node" },
            nil: null,
            primitive: "broken",
            invalidObject: { command: 42 },
          },
        })}
      />,
    );

    expect(screen.getByText("valid")).toBeInTheDocument();
    expect(screen.getByText("Command: node")).toBeInTheDocument();
    expect(screen.getByText("nil")).toBeInTheDocument();
    expect(screen.getByText("primitive")).toBeInTheDocument();
    expect(screen.getAllByText("deeplink.mcp.invalidServerSpec")).toHaveLength(
      3,
    );
  });
});
