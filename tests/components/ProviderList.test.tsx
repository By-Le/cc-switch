import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import type { Provider } from "@/types";
import { ProviderList } from "@/components/providers/ProviderList";

const useDragSortMock = vi.fn();
const useSortableMock = vi.fn();
const providerCardRenderSpy = vi.fn();
const checkProviderMock = vi.fn();
const settingsApiGetMock = vi.fn();
const settingsApiSaveMock = vi.fn();
const getStreamCheckConfigMock = vi.fn();
const fetchModelsForConfigMock = vi.fn();
let autoFailoverEnabled = false;
let failoverQueue: Array<{ providerId: string; providerName: string }> = [];
let lastStreamCheckResults: Record<string, unknown> = {};

const defaultStreamCheckConfig = {
  timeoutSecs: 15,
  maxRetries: 0,
  degradedThresholdMs: 3000,
  claudeModel: "claude-haiku-4-5-20251001",
  codexModel: "gpt-5.5",
  geminiModel: "gemini-3.5-flash",
  testPrompt: "Who are you?",
};

vi.mock("@/hooks/useDragSort", () => ({
  useDragSort: (...args: unknown[]) => useDragSortMock(...args),
}));

vi.mock("@/components/providers/ProviderCard", () => ({
  ProviderCard: (props: any) => {
    providerCardRenderSpy(props);
    const {
      provider,
      onSwitch,
      onEdit,
      onDelete,
      onDuplicate,
      onConfigureUsage,
      onTest,
    } = props;

    return (
      <div data-testid={`provider-card-${provider.id}`}>
        <button
          data-testid={`switch-${provider.id}`}
          onClick={() => onSwitch(provider)}
        >
          switch
        </button>
        <button
          data-testid={`edit-${provider.id}`}
          onClick={() => onEdit(provider)}
        >
          edit
        </button>
        <button
          data-testid={`duplicate-${provider.id}`}
          onClick={() => onDuplicate(provider)}
        >
          duplicate
        </button>
        <button
          data-testid={`usage-${provider.id}`}
          onClick={() => onConfigureUsage(provider)}
        >
          usage
        </button>
        <button
          data-testid={`delete-${provider.id}`}
          onClick={() => onDelete(provider)}
        >
          delete
        </button>
        <button
          data-testid={`test-${provider.id}`}
          onClick={() => onTest?.(provider)}
        >
          test
        </button>
        <span data-testid={`is-current-${provider.id}`}>
          {props.isCurrent ? "current" : "inactive"}
        </span>
        <span data-testid={`drag-attr-${provider.id}`}>
          {props.dragHandleProps?.attributes?.["data-dnd-id"] ?? "none"}
        </span>
        <span data-testid={`active-count-${provider.id}`}>
          {props.activeConnectionCount ?? 0}
        </span>
        <button
          data-testid={`active-sessions-${provider.id}`}
          onClick={() => props.onShowActiveSessions?.()}
        >
          active sessions
        </button>
      </div>
    );
  },
}));

vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    get: (...args: unknown[]) => settingsApiGetMock(...args),
    save: (...args: unknown[]) => settingsApiSaveMock(...args),
  },
}));

vi.mock("@/lib/api/model-test", () => ({
  getStreamCheckConfig: (...args: unknown[]) =>
    getStreamCheckConfigMock(...args),
}));

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: (...args: unknown[]) =>
    fetchModelsForConfigMock(...args),
  showFetchModelsError: vi.fn(),
}));

vi.mock("@/components/UsageFooter", () => ({
  default: () => <div data-testid="usage-footer" />,
}));

vi.mock("@dnd-kit/sortable", async () => {
  const actual = await vi.importActual<any>("@dnd-kit/sortable");

  return {
    ...actual,
    useSortable: (...args: unknown[]) => useSortableMock(...args),
  };
});

// Mock hooks that use QueryClient
vi.mock("@/hooks/useStreamCheck", () => ({
  useStreamCheck: () => ({
    checkProvider: checkProviderMock,
    isChecking: () => false,
    lastResults: lastStreamCheckResults,
  }),
}));

vi.mock("@/lib/query/failover", () => ({
  useAutoFailoverEnabled: () => ({ data: autoFailoverEnabled }),
  useFailoverQueue: () => ({ data: failoverQueue }),
  useAddToFailoverQueue: () => ({ mutate: vi.fn() }),
  useRemoveFromFailoverQueue: () => ({ mutate: vi.fn() }),
  useReorderFailoverQueue: () => ({ mutate: vi.fn() }),
}));

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: overrides.id ?? "provider-1",
    name: overrides.name ?? "Test Provider",
    settingsConfig: overrides.settingsConfig ?? {},
    category: overrides.category,
    createdAt: overrides.createdAt,
    sortIndex: overrides.sortIndex,
    meta: overrides.meta,
    websiteUrl: overrides.websiteUrl,
  };
}

function renderWithQueryClient(
  ui: ReactElement,
  options: { seedSettings?: boolean } = {},
) {
  const { seedSettings = true } = options;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (seedSettings) {
    queryClient.setQueryData(["settings"], { streamCheckConfirmed: true });
  }
  queryClient.setQueryData(["streamCheckConfig"], defaultStreamCheckConfig);

  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  useDragSortMock.mockReset();
  useSortableMock.mockReset();
  providerCardRenderSpy.mockClear();
  checkProviderMock.mockReset();
  settingsApiGetMock.mockReset();
  settingsApiSaveMock.mockReset();
  getStreamCheckConfigMock.mockReset();
  fetchModelsForConfigMock.mockReset();

  useSortableMock.mockImplementation(({ id }: { id: string }) => ({
    setNodeRef: vi.fn(),
    attributes: { "data-dnd-id": id },
    listeners: { onPointerDown: vi.fn() },
    transform: null,
    transition: null,
    isDragging: false,
  }));

  useDragSortMock.mockReturnValue({
    sortedProviders: [],
    sensors: [],
    handleDragEnd: vi.fn(),
  });
  autoFailoverEnabled = false;
  failoverQueue = [];
  lastStreamCheckResults = {};
  settingsApiGetMock.mockResolvedValue({ streamCheckConfirmed: true });
  settingsApiSaveMock.mockResolvedValue(true);
  getStreamCheckConfigMock.mockResolvedValue(defaultStreamCheckConfig);
  fetchModelsForConfigMock.mockResolvedValue([]);
});

describe("ProviderList Component", () => {
  it("should render skeleton placeholders when loading", () => {
    const { container } = renderWithQueryClient(
      <ProviderList
        providers={{}}
        currentProviderId=""
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
        isLoading
      />,
    );

    const placeholders = container.querySelectorAll(
      ".border-dashed.border-muted-foreground\\/40",
    );
    expect(placeholders).toHaveLength(3);
  });

  it("should show empty state and trigger create callback when no providers exist", () => {
    const handleCreate = vi.fn();
    useDragSortMock.mockReturnValueOnce({
      sortedProviders: [],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{}}
        currentProviderId=""
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
        onCreate={handleCreate}
      />,
    );

    const addButton = screen.getByRole("button", {
      name: "provider.addProvider",
    });
    fireEvent.click(addButton);

    expect(handleCreate).toHaveBeenCalledTimes(1);
  });

  it("should render in order returned by useDragSort and pass through action callbacks", () => {
    const providerA = createProvider({ id: "a", name: "A" });
    const providerB = createProvider({ id: "b", name: "B" });

    const handleSwitch = vi.fn();
    const handleEdit = vi.fn();
    const handleDelete = vi.fn();
    const handleDuplicate = vi.fn();
    const handleUsage = vi.fn();
    const handleOpenWebsite = vi.fn();

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerB, providerA],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ a: providerA, b: providerB }}
        currentProviderId="b"
        appId="claude"
        onSwitch={handleSwitch}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onDuplicate={handleDuplicate}
        onConfigureUsage={handleUsage}
        onOpenWebsite={handleOpenWebsite}
      />,
    );

    // Verify sort order
    expect(providerCardRenderSpy).toHaveBeenCalledTimes(2);
    expect(providerCardRenderSpy.mock.calls[0][0].provider.id).toBe("b");
    expect(providerCardRenderSpy.mock.calls[1][0].provider.id).toBe("a");

    // Verify current provider marker
    expect(providerCardRenderSpy.mock.calls[0][0].isCurrent).toBe(true);

    // Drag attributes from useSortable
    expect(
      providerCardRenderSpy.mock.calls[0][0].dragHandleProps?.attributes[
        "data-dnd-id"
      ],
    ).toBe("b");
    expect(
      providerCardRenderSpy.mock.calls[1][0].dragHandleProps?.attributes[
        "data-dnd-id"
      ],
    ).toBe("a");

    // Trigger action buttons
    fireEvent.click(screen.getByTestId("switch-b"));
    fireEvent.click(screen.getByTestId("edit-b"));
    fireEvent.click(screen.getByTestId("duplicate-b"));
    fireEvent.click(screen.getByTestId("usage-b"));
    fireEvent.click(screen.getByTestId("delete-a"));

    expect(handleSwitch).toHaveBeenCalledWith(providerB);
    expect(handleEdit).toHaveBeenCalledWith(providerB);
    expect(handleDuplicate).toHaveBeenCalledWith(providerB);
    expect(handleUsage).toHaveBeenCalledWith(providerB);
    expect(handleDelete).toHaveBeenCalledWith(providerA);

    // Verify useDragSort call parameters
    expect(useDragSortMock).toHaveBeenCalledWith(
      { a: providerA, b: providerB },
      "claude",
    );
  });

  it("filters providers with the search input", () => {
    const providerAlpha = createProvider({ id: "alpha", name: "Alpha Labs" });
    const providerBeta = createProvider({ id: "beta", name: "Beta Works" });

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerAlpha, providerBeta],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ alpha: providerAlpha, beta: providerBeta }}
        currentProviderId=""
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const searchInput = screen.getByPlaceholderText(
      "Search name, notes, or URL...",
    );
    // Initially both providers are rendered
    expect(screen.getByTestId("provider-card-alpha")).toBeInTheDocument();
    expect(screen.getByTestId("provider-card-beta")).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "beta" } });
    expect(screen.queryByTestId("provider-card-alpha")).not.toBeInTheDocument();
    expect(screen.getByTestId("provider-card-beta")).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "gamma" } });
    expect(screen.queryByTestId("provider-card-alpha")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-card-beta")).not.toBeInTheDocument();
    expect(
      screen.getByText("No providers match your search."),
    ).toBeInTheDocument();
  });

  it("can show only providers enabled in failover mode", () => {
    const providerA = createProvider({ id: "a", name: "A" });
    const providerB = createProvider({ id: "b", name: "B" });

    autoFailoverEnabled = true;
    failoverQueue = [{ providerId: "b", providerName: "B" }];
    useDragSortMock.mockReturnValue({
      sortedProviders: [providerA, providerB],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ a: providerA, b: providerB }}
        currentProviderId=""
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
        isProxyTakeover
      />,
    );

    expect(screen.getByTestId("provider-card-a")).toBeInTheDocument();
    expect(screen.getByTestId("provider-card-b")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "只显示启用" }));

    expect(screen.queryByTestId("provider-card-a")).not.toBeInTheDocument();
    expect(screen.getByTestId("provider-card-b")).toBeInTheDocument();
  });

  it("passes active session counts by provider", () => {
    const providerA = createProvider({ id: "a", name: "A" });
    const providerB = createProvider({ id: "b", name: "B" });

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerA, providerB],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ a: providerA, b: providerB }}
        currentProviderId=""
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
        activeProviderTargets={[
          {
            app_type: "claude",
            provider_id: "a",
            provider_name: "A",
            active_connections: 2,
            session_ids: ["s2", "s1"],
          },
          {
            app_type: "codex",
            provider_id: "b",
            provider_name: "B",
            active_connections: 1,
            session_ids: ["ignored"],
          },
        ]}
      />,
    );

    expect(screen.getByTestId("active-count-a")).toHaveTextContent("2");
    expect(screen.getByTestId("active-count-b")).toHaveTextContent("0");
    expect(providerCardRenderSpy.mock.calls[0][0].activeSessionIds).toBe(
      undefined,
    );
  });

  it("shows active session ids dialog", () => {
    const providerA = createProvider({ id: "a", name: "A" });

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerA],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ a: providerA }}
        currentProviderId=""
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
        activeProviderTargets={[
          {
            app_type: "claude",
            provider_id: "a",
            provider_name: "A",
            active_connections: 2,
            session_ids: ["session-b", "session-a"],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId("active-sessions-a"));

    expect(screen.getByText("活跃会话")).toBeInTheDocument();
    expect(screen.getByText("session-a")).toBeInTheDocument();
    expect(screen.getByText("session-b")).toBeInTheDocument();
  });

  it("passes the latest stream check result to provider cards", () => {
    const providerA = createProvider({ id: "a", name: "A" });
    const latestResult = {
      providerId: "a",
      status: "operational",
      success: true,
      message: "ok",
      responseTimeMs: 320,
      modelUsed: "claude-test-model",
      testedAt: 1_700_000_000,
      retryCount: 0,
    };

    lastStreamCheckResults = { a: latestResult };
    useDragSortMock.mockReturnValue({
      sortedProviders: [providerA],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ a: providerA }}
        currentProviderId=""
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    expect(providerCardRenderSpy.mock.calls[0][0].lastTestResult).toBe(
      latestResult,
    );
  });

  it("shows selectable test models and uses the selected option", async () => {
    const provider = createProvider({
      id: "codex-a",
      name: "Codex A",
      settingsConfig: {
        config: 'model = "runtime-model"',
        modelCatalog: {
          models: [
            { model: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" },
            { model: "gpt-5.5" },
          ],
        },
      },
    });

    useDragSortMock.mockReturnValue({
      sortedProviders: [provider],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ "codex-a": provider }}
        currentProviderId=""
        appId="codex"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("test-codex-a"));

    expect(await screen.findByText("选择测试模型")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek V4 Flash")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "DeepSeek V4 Flash" }));
    expect(screen.getByDisplayValue("deepseek-v4-flash")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始测试" }));

    expect(checkProviderMock).toHaveBeenCalledWith(
      "codex-a",
      "Codex A",
      "deepseek-v4-flash",
    );
  });

  it("fetches test model list and fills input from the selected model", async () => {
    fetchModelsForConfigMock.mockResolvedValue([
      { id: "model-from-fetch-a", ownedBy: "vendor-a" },
      { id: "model-from-fetch-b", ownedBy: "vendor-a" },
    ]);

    const provider = createProvider({
      id: "codex-fetch",
      name: "Codex Fetch",
      meta: { isFullUrl: true, customUserAgent: "Custom UA" },
      settingsConfig: {
        auth: { OPENAI_API_KEY: "sk-test" },
        config: `
model = ""
base_url = "https://api.example.com/v1"
`,
      },
    });

    useDragSortMock.mockReturnValue({
      sortedProviders: [provider],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ "codex-fetch": provider }}
        currentProviderId=""
        appId="codex"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("test-codex-fetch"));
    await screen.findByText("选择测试模型");

    fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));

    expect(fetchModelsForConfigMock).toHaveBeenCalledWith(
      "https://api.example.com/v1",
      "sk-test",
      true,
      undefined,
      "Custom UA",
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "model-from-fetch-b" }),
    );
    expect(screen.getByDisplayValue("model-from-fetch-b")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始测试" }));

    expect(checkProviderMock).toHaveBeenCalledWith(
      "codex-fetch",
      "Codex Fetch",
      "model-from-fetch-b",
    );
  });

  it("accepts manual test model input", async () => {
    const provider = createProvider({
      id: "codex-b",
      name: "Codex B",
      settingsConfig: {
        config: 'model = "runtime-model"',
      },
    });

    useDragSortMock.mockReturnValue({
      sortedProviders: [provider],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ "codex-b": provider }}
        currentProviderId=""
        appId="codex"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("test-codex-b"));
    await screen.findByText("选择测试模型");

    const input = screen.getByPlaceholderText("输入模型名，或从上方选择");
    fireEvent.change(input, { target: { value: "manual-model-x" } });
    fireEvent.click(screen.getByRole("button", { name: "开始测试" }));

    expect(checkProviderMock).toHaveBeenCalledWith(
      "codex-b",
      "Codex B",
      "manual-model-x",
    );
  });

  it("persists stream check confirmation even when settings query is not warm", async () => {
    const provider = createProvider({
      id: "codex-c",
      name: "Codex C",
      settingsConfig: {
        config: 'model = "runtime-model"',
      },
    });

    settingsApiGetMock.mockResolvedValue({
      showInTray: true,
      minimizeToTrayOnClose: true,
      language: "zh",
      streamCheckConfirmed: false,
      webdavSync: { password: "" },
      s3Sync: { secretAccessKey: "" },
    });
    useDragSortMock.mockReturnValue({
      sortedProviders: [provider],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ "codex-c": provider }}
        currentProviderId=""
        appId="codex"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
      { seedSettings: false },
    );

    fireEvent.click(screen.getByTestId("test-codex-c"));
    fireEvent.click(await screen.findByText("confirm.streamCheck.confirm"));

    expect(await screen.findByText("选择测试模型")).toBeInTheDocument();
    expect(settingsApiSaveMock).toHaveBeenCalledWith(
      expect.objectContaining({ streamCheckConfirmed: true }),
    );
    expect(settingsApiSaveMock.mock.calls[0][0]).not.toHaveProperty(
      "webdavSync",
    );
    expect(settingsApiSaveMock.mock.calls[0][0]).not.toHaveProperty("s3Sync");
  });
});
