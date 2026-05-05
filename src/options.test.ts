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
          <input id="glossary-source-input" />
          <input id="glossary-target-input" />
          <button id="glossary-add-button" type="button">添加</button>
          <input id="glossary-search-input" />
          <span id="glossary-count"></span>
          <p id="glossary-feedback"></p>
          <p id="glossary-empty"></p>
          <div id="glossary-list"></div>
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

  it("selects OpenAI by default for new users while keeping Google switchable", async () => {
    storageStore = {};

    await import("./options");

    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>("[data-provider-tab='openai']")
          ?.classList.contains("is-active")
      ).toBe(true);
      expect(
        document.querySelector<HTMLElement>("[data-provider-pane='openai']")
          ?.classList.contains("is-active")
      ).toBe(true);
      expect(document.getElementById("active-provider-label")?.textContent).toBe(
        "OpenAI 兼容接口"
      );
    });

    document
      .querySelector<HTMLButtonElement>("[data-provider-tab='google']")
      ?.click();

    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>("[data-provider-tab='google']")
          ?.classList.contains("is-active")
      ).toBe(true);
      expect(
        document.querySelector<HTMLElement>("[data-provider-pane='google']")
          ?.classList.contains("is-active")
      ).toBe(true);
      expect(document.getElementById("active-provider-label")?.textContent).toBe(
        "Google Translate API"
      );
    });
  });

  it("manages glossary terms in settings without changing provider settings", async () => {
    await import("./options");

    await vi.waitFor(() => {
      expect(document.getElementById("glossary-empty")?.hidden).toBe(false);
    });

    (document.getElementById("glossary-source-input") as HTMLInputElement).value =
      "React Server Components";
    (document.getElementById("glossary-target-input") as HTMLInputElement).value =
      "React 服务器组件";
    (document.getElementById("glossary-add-button") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(document.getElementById("glossary-count")?.textContent).toBe("1 条");
      expect(document.getElementById("glossary-empty")?.hidden).toBe(true);
      expect(document.querySelectorAll(".glossary-term-row")).toHaveLength(1);
    });

    expect(storageStore["litetrace.glossary.terms"]).toMatchObject({
      version: 1,
      terms: [
        {
          sourceText: "React Server Components",
          targetText: "React 服务器组件",
          enabled: true
        }
      ]
    });

    const targetInput = document.querySelectorAll<HTMLInputElement>(
      ".glossary-term-row input"
    )[2];
    targetInput.value = "RSC";
    document
      .querySelector<HTMLButtonElement>(".glossary-term-row button[data-action='save']")
      ?.click();

    await vi.waitFor(() => {
      expect(
        (storageStore["litetrace.glossary.terms"] as { terms: Array<{ targetText: string }> })
          .terms[0].targetText
      ).toBe("RSC");
    });

    const enabledInput = document.querySelector<HTMLInputElement>(
      ".glossary-term-row input[type='checkbox']"
    );
    enabledInput?.click();

    await vi.waitFor(() => {
      expect(
        (storageStore["litetrace.glossary.terms"] as { terms: Array<{ enabled: boolean }> })
          .terms[0].enabled
      ).toBe(false);
    });

    const sourceInput = document.querySelectorAll<HTMLInputElement>(
      ".glossary-term-row input"
    )[1];
    const renamedTargetInput = document.querySelectorAll<HTMLInputElement>(
      ".glossary-term-row input"
    )[2];
    sourceInput.value = "React Compiler";
    renamedTargetInput.value = "React 编译器";
    document
      .querySelector<HTMLButtonElement>(".glossary-term-row button[data-action='save']")
      ?.click();

    await vi.waitFor(() => {
      const terms = (
        storageStore["litetrace.glossary.terms"] as {
          terms: Array<{
            sourceText: string;
            targetText: string;
            enabled: boolean;
          }>;
        }
      ).terms;

      expect(terms).toHaveLength(1);
      expect(terms[0]).toMatchObject({
        sourceText: "React Compiler",
        targetText: "React 编译器",
        enabled: false
      });
    });

    document
      .querySelector<HTMLButtonElement>(".glossary-term-row button[data-action='delete']")
      ?.click();

    await vi.waitFor(() => {
      expect(
        (storageStore["litetrace.glossary.terms"] as { terms: unknown[] }).terms
      ).toHaveLength(0);
    });
  });
});
