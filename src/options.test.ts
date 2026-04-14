import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function renderOptionsFixture(): void {
  document.body.innerHTML = `
    <main class="page-shell">
      <section class="settings-card">
        <header class="page-header">
          <div class="meta-row" aria-label="当前状态">
            <div class="meta-item">
              <strong id="active-provider-label">读取中…</strong>
            </div>
            <div class="meta-badges">
              <span id="fields-status" class="status-badge" data-state="idle">待补充</span>
              <span id="connection-status" class="status-badge" data-state="idle">待授权</span>
            </div>
          </div>
        </header>

        <form id="settings-form" class="settings-form">
          <button data-provider-tab="google" type="button"></button>
          <button data-provider-tab="openai" type="button"></button>
          <section data-provider-pane="google"></section>
          <section data-provider-pane="openai"></section>
          <input id="google-api-key" />
          <input id="openai-base-url" />
          <input id="openai-model" />
          <input id="openai-api-key" />
          <button id="save-button" type="submit">保存</button>
          <button id="verify-button" type="button">保存并验证</button>
        </form>

        <div id="feedback" hidden></div>
        <section id="success-panel" hidden>
          <h2 id="success-title"></h2>
          <p id="success-description"></p>
          <button id="finish-button" type="button">返回开始使用</button>
        </section>
      </section>
    </main>
  `;
}

describe("options runtime", () => {
  let storageStore: Record<string, unknown>;
  let storageSetMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    renderOptionsFixture();
    storageStore = {
      "litetrace.settings": {
        activeProvider: "google",
        google: {
          apiKey: "demo-key"
        },
        preferences: {
          hasCompletedSetup: true
        }
      }
    };
    storageSetMock = vi.fn(async (items: Record<string, unknown>) => {
      storageStore = {
        ...storageStore,
        ...items
      };
    });

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({
          ok: true,
          translations: ["你好"],
          meta: {
            cacheHits: 0,
            requestedCount: 1,
            networkCount: 1
          }
        }),
        openOptionsPage: vi.fn().mockResolvedValue(undefined)
      },
      permissions: {
        contains: vi.fn().mockResolvedValue(true),
        request: vi.fn().mockResolvedValue(true)
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => (key in storageStore ? { [key]: storageStore[key] } : {})),
          set: storageSetMock
        }
      }
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("keeps the fixed bubble-trigger selection interaction without exposing a setting", async () => {
    await import("./options");

    (document.getElementById("settings-form") as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );

    await vi.waitFor(() => {
      expect(storageSetMock).toHaveBeenCalled();
    });

    const savedSettings = storageSetMock.mock.calls.at(-1)?.[0]?.[
      "litetrace.settings"
    ] as { preferences?: Record<string, unknown> };

    expect(Object.keys(savedSettings.preferences ?? {}).sort()).toEqual([
      "hasCompletedSetup",
      "hasSeenReadingCoachmark",
      "pageScope",
      "targetLang"
    ]);
  });
});
