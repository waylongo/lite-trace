import { getExtensionStatus, triggerActiveTabImmersive } from "./background-runtime";

describe("background runtime helpers", () => {
  let storageStore: Record<string, unknown>;
  let sendMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storageStore = {};
    sendMessageMock = vi.fn(async (_tabId: number, message: { type?: string }) => {
      if (message.type === "PING") {
        return { ok: true };
      }

      if (message.type === "GET_PAGE_IMMERSIVE_STATE") {
        return { ok: true, immersiveActive: true };
      }

      return { ok: true };
    });

    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([
          {
            id: 99,
            url: "https://example.com/article"
          }
        ]),
        sendMessage: sendMessageMock
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue(undefined)
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => (key in storageStore ? { [key]: storageStore[key] } : {})),
          set: vi.fn(async (items: Record<string, unknown>) => {
            storageStore = {
              ...storageStore,
              ...items
            };
          })
        }
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports extension status for the active tab", async () => {
    storageStore["litetrace.settings"] = {
      activeProvider: "openai",
      openai: {
        baseUrl: "https://api.example.com/v1",
        model: "demo-model",
        apiKey: "sk-demo"
      },
      preferences: {
        hasCompletedSetup: true
      }
    };

    await expect(getExtensionStatus()).resolves.toMatchObject({
      configured: true,
      providerLabel: "OpenAI 兼容接口",
      hasCompletedSetup: true,
      activeTabSupported: true,
      activeTabImmersiveActive: true
    });
  });

  it("triggers immersive translation on the active tab", async () => {
    storageStore["litetrace.settings"] = {
      activeProvider: "google",
      google: {
        apiKey: "demo-key"
      }
    };

    await expect(triggerActiveTabImmersive()).resolves.toEqual({ ok: true });

    expect(sendMessageMock).toHaveBeenCalledWith(99, {
      type: "TOGGLE_IMMERSIVE_TRANSLATION"
    });
  });

  it("fails with a specific message when the active tab cannot be reached", async () => {
    storageStore["litetrace.settings"] = {
      activeProvider: "google",
      google: {
        apiKey: "demo-key"
      }
    };

    sendMessageMock
      .mockRejectedValueOnce(new Error("no receiver"))
      .mockRejectedValueOnce(new Error("still no receiver"));

    await expect(triggerActiveTabImmersive()).rejects.toThrow(
      "LiteTrace 没有成功注入当前页面，请刷新页面后再试一次。"
    );
  });
});
