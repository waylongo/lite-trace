import { getExtensionStatus, triggerActiveTabImmersive } from "./background-runtime";

describe("background runtime helpers", () => {
  let storageStore: Record<string, unknown>;
  let sendMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.useRealTimers();
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

  it("retries after injecting the content script when the first message misses the receiver", async () => {
    storageStore["litetrace.settings"] = {
      activeProvider: "google",
      google: {
        apiKey: "demo-key"
      }
    };

    sendMessageMock
      .mockRejectedValueOnce(new Error("no receiver"))
      .mockRejectedValueOnce(new Error("still wiring listeners"))
      .mockResolvedValueOnce({ ok: true });

    const request = triggerActiveTabImmersive();

    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual({ ok: true });
    expect(sendMessageMock).toHaveBeenCalledWith(99, {
      type: "TOGGLE_IMMERSIVE_TRANSLATION"
    });
  });

  it("fails with a softer reconnect message when the page still cannot be reached", async () => {
    storageStore["litetrace.settings"] = {
      activeProvider: "google",
      google: {
        apiKey: "demo-key"
      }
    };

    sendMessageMock
      .mockRejectedValueOnce(new Error("no receiver"))
      .mockRejectedValueOnce(new Error("still no receiver"))
      .mockRejectedValueOnce(new Error("still no receiver"))
      .mockRejectedValueOnce(new Error("still no receiver"));

    const request = expect(triggerActiveTabImmersive()).rejects.toThrow(
      "当前页面没有成功连接 LiteTrace，请稍后重试。"
    );

    await vi.runAllTimersAsync();
    await request;
  });
});
