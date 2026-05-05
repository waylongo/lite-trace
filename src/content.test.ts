import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeMessage, TranslationResponse } from "./shared/types";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

describe("content selection translation", () => {
  const immersiveBubblePositionKey = "litetrace.immersiveBubble.yRatio";
  let sendMessageMock: ReturnType<typeof vi.fn>;
  let onMessageListener:
    | ((
        message: RuntimeMessage,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response?: unknown) => void
      ) => boolean)
    | null;
  let storageStore: Record<string, unknown>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/initial");
    onMessageListener = null;
    storageStore = {
      "litetrace.settings": {
        preferences: {
        }
      }
    };
    sendMessageMock = vi.fn(
      async (message: RuntimeMessage): Promise<TranslationResponse | { ok: true }> => {
        if (message.type === "TRANSLATE_SELECTION") {
          return {
            ok: true,
            translations: ["默认译文"],
            meta: {
              cacheHits: 0,
              requestedCount: 1,
              networkCount: 1
            }
          };
        }

        return { ok: true };
      }
    );

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: sendMessageMock,
        onMessage: {
          addListener: vi.fn(
            (
              listener: (
                message: RuntimeMessage,
                sender: chrome.runtime.MessageSender,
                sendResponse: (response?: unknown) => void
              ) => boolean
            ) => {
              onMessageListener = listener;
            }
          )
        }
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

    Object.defineProperty(window.Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(100, 80, 60, 20)
    });
    Object.defineProperty(window.Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [new DOMRect(100, 80, 60, 20)]
    });
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });
    delete (window as Window & { __litetraceInitialized?: boolean }).__litetraceInitialized;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    [
      "litetrace-selection-bubble",
      "litetrace-immersive-bubble",
      "litetrace-selection-popup",
      "litetrace-glossary-editor",
      "litetrace-toast",
      "litetrace-inline-style"
    ].forEach((id) => {
      document.getElementById(id)?.remove();
    });
    window.getSelection()?.removeAllRanges();
    vi.unstubAllGlobals();
  });

  function selectNodeText(element: HTMLElement): void {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  async function showBubbleFor(element: HTMLElement): Promise<void> {
    selectNodeText(element);
    document.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: 120,
        clientY: 100
      })
    );
    await vi.advanceTimersByTimeAsync(220);
  }

  async function importContentModule(): Promise<void> {
    await import("./content");
  }

  async function dispatchContentMessage(message: RuntimeMessage): Promise<unknown> {
    return await new Promise((resolve) => {
      expect(onMessageListener).not.toBeNull();
      const keepAlive = onMessageListener?.(
        message,
        { tab: { id: 99 } as chrome.tabs.Tab },
        resolve
      );
      expect(keepAlive).toBe(true);
    });
  }

  function dispatchPointerEvent(
    target: EventTarget,
    type: string,
    clientY: number,
    pointerId = 1
  ): void {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientY
    });
    Object.defineProperty(event, "pointerId", {
      configurable: true,
      value: pointerId
    });
    target.dispatchEvent(event);
  }

  function getImmersiveBubble(): HTMLButtonElement {
    return document.getElementById(
      "litetrace-immersive-bubble"
    ) as HTMLButtonElement;
  }

  function getImmersiveBubbleIcon(bubble = getImmersiveBubble()): string | null {
    return bubble
      .querySelector(".litetrace-immersive-icon svg")
      ?.getAttribute("data-icon") ?? null;
  }

  function getSelectionBubbleIcon(): string | null {
    return document
      .querySelector("#litetrace-selection-bubble svg")
      ?.getAttribute("data-icon") ?? null;
  }

  it("shows a trigger bubble for short english selections without auto-translating", async () => {
    document.body.innerHTML = `<p id="text">hello</p>`;

    await importContentModule();
    await showBubbleFor(document.getElementById("text") as HTMLElement);

    const bubble = document.getElementById("litetrace-selection-bubble") as HTMLButtonElement;
    expect(bubble.hidden).toBe(false);
    expect(bubble.textContent?.trim()).toBe("");
    expect(bubble.getAttribute("aria-label")).toBe("翻译所选内容");
    expect(bubble.title).toBe("翻译所选内容");
    expect(getSelectionBubbleIcon()).toBe("translate");
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "TRANSLATE_SELECTION" })
    );
  });

  it("translates after the bubble is clicked", async () => {
    sendMessageMock.mockImplementation(async (message: RuntimeMessage) => {
      if (message.type === "TRANSLATE_SELECTION") {
        return {
          ok: true,
          translations: ["你好"],
          meta: {
            cacheHits: 0,
            requestedCount: 1,
            networkCount: 1
          }
        };
      }

      return { ok: true };
    });
    document.body.innerHTML = `<p id="text">hello</p>`;

    await importContentModule();
    await showBubbleFor(document.getElementById("text") as HTMLElement);

    expect(getImmersiveBubble().dataset.state).toBe("idle");
    expect(getImmersiveBubble().textContent?.trim()).toBe("");
    expect(getImmersiveBubbleIcon()).toBe("translate");
    (document.getElementById("litetrace-selection-bubble") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: "TRANSLATE_SELECTION",
        payload: {
          scene: "selection",
          texts: ["hello"]
        }
      });
    });

    await vi.waitFor(() => {
      expect(document.querySelector(".litetrace-popup-body")?.textContent).toBe("你好");
    });
    expect(
      sendMessageMock.mock.calls.some(
        ([message]) =>
          (message as RuntimeMessage).type === "TRANSLATE_PAGE_BLOCKS"
      )
    ).toBe(false);
  });

  it("opens the glossary editor from the selection context menu message", async () => {
    document.body.innerHTML = `<p id="text">API</p>`;

    await importContentModule();
    selectNodeText(document.getElementById("text") as HTMLElement);

    await dispatchContentMessage({
      type: "OPEN_GLOSSARY_TERM_EDITOR",
      payload: { text: "API" }
    });

    const editor = document.getElementById("litetrace-glossary-editor") as HTMLDivElement;
    const sourceInput = editor.querySelector<HTMLInputElement>("input[name='source']");
    const targetInput = editor.querySelector<HTMLInputElement>("input[name='target']");

    expect(editor.hidden).toBe(false);
    expect(sourceInput?.value).toBe("API");

    targetInput!.value = "接口";
    editor
      .querySelector<HTMLFormElement>(".litetrace-glossary-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(storageStore["litetrace.glossary.terms"]).toMatchObject({
        version: 1,
        terms: [
          {
            sourceText: "API",
            targetText: "接口",
            enabled: true
          }
        ]
      });
      expect(
        editor.querySelector(".litetrace-glossary-feedback")?.textContent
      ).toBe("已保存");
    });

    expect(
      sendMessageMock.mock.calls.some(
        ([message]) =>
          (message as RuntimeMessage).type === "TRANSLATE_SELECTION"
      )
    ).toBe(false);
  });

  it("keeps the glossary editor open if the browser clears selection after right click", async () => {
    document.body.innerHTML = `<p id="text">API</p>`;

    await importContentModule();
    selectNodeText(document.getElementById("text") as HTMLElement);

    await dispatchContentMessage({
      type: "OPEN_GLOSSARY_TERM_EDITOR",
      payload: { text: "API" }
    });

    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));

    const editor = document.getElementById("litetrace-glossary-editor") as HTMLDivElement;
    const sourceInput = editor.querySelector<HTMLInputElement>("input[name='source']");

    expect(editor.hidden).toBe(false);
    expect(sourceInput?.value).toBe("API");
  });

  it("keeps the glossary editor open while clicking inside it or elsewhere", async () => {
    document.body.innerHTML = `<p id="text">API</p>`;

    await importContentModule();
    selectNodeText(document.getElementById("text") as HTMLElement);

    await dispatchContentMessage({
      type: "OPEN_GLOSSARY_TERM_EDITOR",
      payload: { text: "API" }
    });

    const editor = document.getElementById("litetrace-glossary-editor") as HTMLDivElement;
    const targetInput = editor.querySelector<HTMLInputElement>("input[name='target']");

    window.getSelection()?.removeAllRanges();
    targetInput?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    targetInput?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(220);

    expect(editor.hidden).toBe(false);

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(220);

    expect(editor.hidden).toBe(false);

    editor
      .querySelector<HTMLButtonElement>(".litetrace-glossary-close")
      ?.click();
    expect(editor.hidden).toBe(true);
  });

  it("ignores stale responses after the user selects new text", async () => {
    const first = createDeferred<TranslationResponse>();
    const second = createDeferred<TranslationResponse>();

    sendMessageMock.mockImplementation((message: RuntimeMessage) => {
      if (message.type !== "TRANSLATE_SELECTION") {
        return Promise.resolve({ ok: true });
      }

      if (message.payload.texts[0] === "hello") {
        return first.promise;
      }

      return second.promise;
    });
    document.body.innerHTML = `
      <p id="first">hello</p>
      <p id="second">world</p>
    `;

    await importContentModule();

    await showBubbleFor(document.getElementById("first") as HTMLElement);
    (document.getElementById("litetrace-selection-bubble") as HTMLButtonElement).click();

    await showBubbleFor(document.getElementById("second") as HTMLElement);
    (document.getElementById("litetrace-selection-bubble") as HTMLButtonElement).click();

    first.resolve({
      ok: true,
      translations: ["旧译文"],
      meta: {
        cacheHits: 0,
        requestedCount: 1,
        networkCount: 1
      }
    });

    await vi.waitFor(() => {
      expect(document.querySelector(".litetrace-popup-body")?.textContent).not.toBe("旧译文");
    });

    second.resolve({
      ok: true,
      translations: ["新译文"],
      meta: {
        cacheHits: 0,
        requestedCount: 1,
        networkCount: 1
      }
    });

    await vi.waitFor(() => {
      expect(document.querySelector(".litetrace-popup-body")?.textContent).toBe("新译文");
    });
  });

  it("does not show the bubble inside editable content", async () => {
    document.body.innerHTML = `
      <div contenteditable="true">
        <span id="editable">hello</span>
      </div>
    `;

    await importContentModule();
    await showBubbleFor(document.getElementById("editable") as HTMLElement);

    const bubble = document.getElementById("litetrace-selection-bubble") as HTMLButtonElement;
    expect(bubble.hidden).toBe(true);
  });

  it("keeps a single runtime listener set when the content script is injected again", async () => {
    document.body.innerHTML = `<p id="text">hello</p>`;

    await importContentModule();
    vi.resetModules();
    await import("./content");

    expect(document.querySelectorAll("#litetrace-selection-bubble")).toHaveLength(1);
    expect(document.querySelectorAll("#litetrace-immersive-bubble")).toHaveLength(1);
    expect(document.querySelectorAll("#litetrace-selection-popup")).toHaveLength(1);
    expect(document.querySelectorAll("#litetrace-glossary-editor")).toHaveLength(1);
    expect(document.querySelectorAll("#litetrace-toast")).toHaveLength(1);
    expect(document.querySelectorAll("#litetrace-inline-style")).toHaveLength(1);
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);

    await showBubbleFor(document.getElementById("text") as HTMLElement);
    (document.getElementById("litetrace-selection-bubble") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(
        sendMessageMock.mock.calls.filter(
          ([message]) =>
            (message as RuntimeMessage).type === "TRANSLATE_SELECTION"
        )
      ).toHaveLength(1);
    });
  });

  it("shows a persistent immersive bubble and uses it to start and cancel generation", async () => {
    const firstBatch = createDeferred<TranslationResponse>();

    sendMessageMock.mockImplementation((message: RuntimeMessage) => {
      if (message.type === "TRANSLATE_PAGE_BLOCKS") {
        return firstBatch.promise;
      }

      return Promise.resolve({ ok: true });
    });
    document.body.innerHTML = `
      <main>
        <p>This first English paragraph is long enough to be translated for reading.</p>
      </main>
    `;

    await importContentModule();

    const immersiveBubble = getImmersiveBubble();

    expect(immersiveBubble.hidden).toBe(false);
    expect(immersiveBubble.textContent?.trim()).toBe("");
    expect(immersiveBubble.dataset.state).toBe("idle");
    expect(immersiveBubble.getAttribute("aria-label")).toBe("开启双语阅读");
    expect(getImmersiveBubbleIcon(immersiveBubble)).toBe("translate");

    immersiveBubble.click();
    expect(immersiveBubble.dataset.state).toBe("loading");
    expect(immersiveBubble.dataset.progress).toBe("indeterminate");
    expect(immersiveBubble.getAttribute("aria-label")).toBe("停止生成双语阅读");
    expect(getImmersiveBubbleIcon(immersiveBubble)).toBe("stop");

    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: "TRANSLATE_PAGE_BLOCKS",
        payload: {
          texts: [
            "This first English paragraph is long enough to be translated for reading."
          ],
          scene: "page",
          immersiveJobId: 1
        }
      });
    });
    await vi.waitFor(() => {
      expect(immersiveBubble.dataset.progress).toBe("determinate");
      expect(immersiveBubble.style.getPropertyValue("--litetrace-progress")).toBe(
        "0deg"
      );
      expect(immersiveBubble.title).toContain("已完成 0/1");
    });

    immersiveBubble.click();

    await vi.waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: "CANCEL_IMMERSIVE_TRANSLATION",
        payload: {
          immersiveJobId: 1
        }
      });
    });
    expect(immersiveBubble.dataset.state).toBe("idle");
    expect(immersiveBubble.dataset.progress).toBeUndefined();
    expect(getImmersiveBubbleIcon(immersiveBubble)).toBe("translate");

    firstBatch.resolve({
      ok: true,
      translations: ["第一段译文"],
      meta: {
        cacheHits: 0,
        requestedCount: 1,
        networkCount: 1
      }
    });
  });

  it("uses the immersive bubble to close active translations", async () => {
    sendMessageMock.mockImplementation((message: RuntimeMessage) => {
      if (message.type === "TRANSLATE_PAGE_BLOCKS") {
        return Promise.resolve({
          ok: true,
          translations: ["第一段译文"],
          meta: {
            cacheHits: 0,
            requestedCount: 1,
            networkCount: 1
          }
        });
      }

      return Promise.resolve({ ok: true });
    });
    document.body.innerHTML = `
      <main>
        <p>This first English paragraph is long enough to be translated for reading.</p>
      </main>
    `;

    await importContentModule();

    const immersiveBubble = getImmersiveBubble();

    immersiveBubble.click();
    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(1);
      expect(immersiveBubble.dataset.state).toBe("active");
      expect(immersiveBubble.dataset.progress).toBeUndefined();
      expect(getImmersiveBubbleIcon(immersiveBubble)).toBe("check");
    });

    immersiveBubble.click();

    expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(0);
    expect(immersiveBubble.dataset.state).toBe("idle");
    expect(getImmersiveBubbleIcon(immersiveBubble)).toBe("translate");
  });

  it("retranslates matching inserted immersive paragraphs after saving a term", async () => {
    let pageRequestCount = 0;

    sendMessageMock.mockImplementation((message: RuntimeMessage) => {
      if (message.type === "TRANSLATE_PAGE_BLOCKS") {
        pageRequestCount += 1;
        return Promise.resolve({
          ok: true,
          translations:
            pageRequestCount === 1
              ? ["旧译文"]
              : ["遵循术语的接口译文"],
          meta: {
            cacheHits: 0,
            requestedCount: 1,
            networkCount: 1
          }
        });
      }

      return Promise.resolve({ ok: true });
    });
    document.body.innerHTML = `
      <main>
        <p>The API remains stable across versions and keeps clients compatible.</p>
      </main>
    `;

    await importContentModule();

    getImmersiveBubble().click();
    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => {
      expect(document.querySelector("[data-litetrace-translation]")?.textContent).toBe(
        "旧译文"
      );
    });

    window.getSelection()?.removeAllRanges();
    await dispatchContentMessage({
      type: "OPEN_GLOSSARY_TERM_EDITOR",
      payload: { text: "API" }
    });

    const editor = document.getElementById("litetrace-glossary-editor") as HTMLDivElement;
    const targetInput = editor.querySelector<HTMLInputElement>("input[name='target']");
    targetInput!.value = "接口";
    editor
      .querySelector<HTMLFormElement>(".litetrace-glossary-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(document.querySelector("[data-litetrace-translation]")?.textContent).toBe(
        "遵循术语的接口译文"
      );
      expect(getImmersiveBubble().dataset.state).toBe("active");
    });
  });

  it("resets active immersive state when the page URL changes", async () => {
    sendMessageMock.mockImplementation((message: RuntimeMessage) => {
      if (message.type === "TRANSLATE_PAGE_BLOCKS") {
        return Promise.resolve({
          ok: true,
          translations: ["第一段译文"],
          meta: {
            cacheHits: 0,
            requestedCount: 1,
            networkCount: 1
          }
        });
      }

      return Promise.resolve({ ok: true });
    });
    document.body.innerHTML = `
      <main>
        <p>This first English paragraph is long enough to be translated for reading.</p>
      </main>
    `;

    await importContentModule();

    const immersiveBubble = getImmersiveBubble();
    immersiveBubble.click();
    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(1);
      expect(immersiveBubble.dataset.state).toBe("active");
    });

    window.history.pushState(null, "", "/next-page");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(0);
    expect(immersiveBubble.dataset.state).toBe("idle");
    expect(immersiveBubble.dataset.progress).toBeUndefined();
    expect(getImmersiveBubbleIcon(immersiveBubble)).toBe("translate");

    await expect(
      dispatchContentMessage({ type: "GET_PAGE_IMMERSIVE_STATE" })
    ).resolves.toMatchObject({
      immersiveActive: false,
      immersiveLoading: false
    });
  });

  it("cancels loading immersive generation on URL changes and ignores stale responses", async () => {
    const firstBatch = createDeferred<TranslationResponse>();

    sendMessageMock.mockImplementation((message: RuntimeMessage) => {
      if (message.type === "TRANSLATE_PAGE_BLOCKS") {
        return firstBatch.promise;
      }

      return Promise.resolve({ ok: true });
    });
    document.body.innerHTML = `
      <main>
        <p>This first English paragraph is long enough to be translated for reading.</p>
      </main>
    `;

    await importContentModule();
    getImmersiveBubble().click();
    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: "TRANSLATE_PAGE_BLOCKS",
        payload: {
          texts: [
            "This first English paragraph is long enough to be translated for reading."
          ],
          scene: "page",
          immersiveJobId: 1
        }
      });
    });

    window.history.pushState(null, "", "/during-loading");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await vi.waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: "CANCEL_IMMERSIVE_TRANSLATION",
        payload: {
          immersiveJobId: 1
        }
      });
    });
    expect(getImmersiveBubble().dataset.state).toBe("idle");
    expect(getImmersiveBubble().dataset.progress).toBeUndefined();

    firstBatch.resolve({
      ok: true,
      translations: ["旧页面译文"],
      meta: {
        cacheHits: 0,
        requestedCount: 1,
        networkCount: 1
      }
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(0);
    await expect(
      dispatchContentMessage({ type: "GET_PAGE_IMMERSIVE_STATE" })
    ).resolves.toMatchObject({
      immersiveActive: false,
      immersiveLoading: false
    });
  });

  it("restores the global immersive bubble vertical position", async () => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800
    });
    storageStore[immersiveBubblePositionKey] = 0.25;
    document.body.innerHTML = `<main></main>`;

    await importContentModule();
    await Promise.resolve();
    await Promise.resolve();

    const immersiveBubble = getImmersiveBubble();

    await vi.waitFor(() => {
      expect(Number.parseFloat(immersiveBubble.style.top)).toBeCloseTo(189);
      expect(immersiveBubble.style.bottom).toBe("auto");
    });
  });

  it("drags the immersive bubble vertically and stores the position without toggling translation", async () => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800
    });
    document.body.innerHTML = `
      <main>
        <p>This first English paragraph is long enough to be translated for reading.</p>
      </main>
    `;

    await importContentModule();

    const immersiveBubble = getImmersiveBubble();

    await vi.waitFor(() => {
      expect(immersiveBubble.style.top).not.toBe("");
    });

    dispatchPointerEvent(immersiveBubble, "pointerdown", 620);
    dispatchPointerEvent(immersiveBubble, "pointermove", 320);
    dispatchPointerEvent(immersiveBubble, "pointerup", 320);
    immersiveBubble.click();

    await vi.waitFor(() => {
      expect(typeof storageStore[immersiveBubblePositionKey]).toBe("number");
    });
    expect(Number.parseFloat(immersiveBubble.style.top)).toBeGreaterThanOrEqual(12);
    expect(
      sendMessageMock.mock.calls.some(
        ([message]) =>
          (message as RuntimeMessage).type === "TRANSLATE_PAGE_BLOCKS"
      )
    ).toBe(false);
  });

  it("keeps successful immersive generation quiet while still showing errors", async () => {
    sendMessageMock.mockImplementation((message: RuntimeMessage) => {
      if (message.type === "TRANSLATE_PAGE_BLOCKS") {
        return Promise.resolve({
          ok: true,
          translations: ["第一段译文"],
          meta: {
            cacheHits: 3,
            requestedCount: 1,
            networkCount: 0
          }
        });
      }

      return Promise.resolve({ ok: true });
    });
    document.body.innerHTML = `
      <main>
        <p>This first English paragraph is long enough to be translated for reading.</p>
      </main>
    `;

    await importContentModule();

    getImmersiveBubble().click();
    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(1);
    });
    expect((document.getElementById("litetrace-toast") as HTMLDivElement).hidden).toBe(true);
  });

  it("still shows an error toast when no English body can be translated", async () => {
    document.body.innerHTML = `<main><p>你好，世界。</p></main>`;

    await importContentModule();

    getImmersiveBubble().click();
    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => {
      expect(document.getElementById("litetrace-toast")?.textContent).toContain(
        "当前页面没有识别到可处理的英文正文。"
      );
    });
  });

  it("responds immediately when immersive generation starts and exposes loading progress", async () => {
    const firstBatch = createDeferred<TranslationResponse>();

    sendMessageMock.mockImplementation((message: RuntimeMessage) => {
      if (message.type === "TRANSLATE_PAGE_BLOCKS") {
        return firstBatch.promise;
      }

      return Promise.resolve({ ok: true });
    });
    document.body.innerHTML = `
      <main>
        <p>This first English paragraph is long enough to be translated for reading.</p>
        <p>This second English paragraph keeps the immersive flow busy during tests.</p>
      </main>
    `;

    await importContentModule();

    await expect(
      dispatchContentMessage({ type: "TOGGLE_IMMERSIVE_TRANSLATION" })
    ).resolves.toEqual({ ok: true });
    expect(getImmersiveBubble().dataset.state).toBe("loading");
    expect(getImmersiveBubble().dataset.progress).toBe("indeterminate");
    expect(
      sendMessageMock.mock.calls.some(
        ([message]) => (message as RuntimeMessage).type === "TRANSLATE_PAGE_BLOCKS"
      )
    ).toBe(false);

    await expect(
      dispatchContentMessage({ type: "GET_PAGE_IMMERSIVE_STATE" })
    ).resolves.toMatchObject({
      immersiveActive: false,
      immersiveLoading: true,
      progress: {
        totalCount: 0,
        completedCount: 0,
        insertedCount: 0,
        cacheHits: 0
      }
    });

    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: "TRANSLATE_PAGE_BLOCKS",
        payload: {
          texts: [
            "This first English paragraph is long enough to be translated for reading.",
            "This second English paragraph keeps the immersive flow busy during tests."
          ],
          scene: "page",
          immersiveJobId: 1
        }
      });
    });

    await expect(
      dispatchContentMessage({ type: "GET_PAGE_IMMERSIVE_STATE" })
    ).resolves.toMatchObject({
      immersiveLoading: true,
      progress: {
        totalCount: 2,
        completedCount: 0,
        insertedCount: 0
      }
    });
    expect(getImmersiveBubble().dataset.progress).toBe("determinate");
    expect(getImmersiveBubble().style.getPropertyValue("--litetrace-progress")).toBe(
      "0deg"
    );

    firstBatch.resolve({
      ok: true,
      translations: ["第一段译文", "第二段译文"],
      meta: {
        cacheHits: 1,
        requestedCount: 2,
        networkCount: 1
      }
    });

    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(2);
    });
  });

  it("stops immersive generation and keeps translations already inserted", async () => {
    const firstBatch = createDeferred<TranslationResponse>();
    const secondBatch = createDeferred<TranslationResponse>();
    const pageBatches = [firstBatch, secondBatch];

    sendMessageMock.mockImplementation((message: RuntimeMessage) => {
      if (message.type === "TRANSLATE_PAGE_BLOCKS") {
        return pageBatches.shift()?.promise ?? Promise.resolve({
          ok: true,
          translations: [],
          meta: {
            cacheHits: 0,
            requestedCount: 0,
            networkCount: 0
          }
        });
      }

      if (message.type === "CANCEL_IMMERSIVE_TRANSLATION") {
        secondBatch.resolve({
          ok: false,
          error: {
            code: "UNKNOWN_ERROR",
            message: "翻译已取消。"
          }
        });
        return Promise.resolve({ ok: true });
      }

      return Promise.resolve({ ok: true });
    });
    document.body.innerHTML = `
      <main>
        <p>This first English paragraph is long enough to be translated for reading.</p>
        <p>This second English paragraph keeps the first visible batch full.</p>
        <p>This third English paragraph completes the initial visible translation batch.</p>
        <p>This fourth English paragraph should remain in the later background batch.</p>
      </main>
    `;

    await importContentModule();
    await dispatchContentMessage({ type: "TOGGLE_IMMERSIVE_TRANSLATION" });
    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => {
      expect(
        sendMessageMock.mock.calls.filter(
          ([message]) =>
            (message as RuntimeMessage).type === "TRANSLATE_PAGE_BLOCKS"
        )
      ).toHaveLength(1);
    });

    firstBatch.resolve({
      ok: true,
      translations: ["第一段译文", "第二段译文", "第三段译文"],
      meta: {
        cacheHits: 0,
        requestedCount: 3,
        networkCount: 3
      }
    });

    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(3);
      expect(
        sendMessageMock.mock.calls.filter(
          ([message]) =>
            (message as RuntimeMessage).type === "TRANSLATE_PAGE_BLOCKS"
        )
      ).toHaveLength(2);
      expect(getImmersiveBubble().dataset.state).toBe("loading");
      expect(getImmersiveBubble().dataset.progress).toBe("determinate");
      expect(getImmersiveBubble().style.getPropertyValue("--litetrace-progress")).toBe(
        "270deg"
      );
      expect(getImmersiveBubble().title).toContain("已完成 3/4");
    });

    await expect(
      dispatchContentMessage({ type: "TOGGLE_IMMERSIVE_TRANSLATION" })
    ).resolves.toEqual({ ok: true });

    await vi.waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: "CANCEL_IMMERSIVE_TRANSLATION",
        payload: {
          immersiveJobId: 1
        }
      });
    });

    await expect(
      dispatchContentMessage({ type: "GET_PAGE_IMMERSIVE_STATE" })
    ).resolves.toMatchObject({
      immersiveActive: true,
      immersiveLoading: false
    });
    expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(3);
    expect(getImmersiveBubble().dataset.state).toBe("active");
    expect(getImmersiveBubble().dataset.progress).toBeUndefined();
    expect(getImmersiveBubbleIcon()).toBe("check");
  });

  it("ignores stale glossary retouch responses after closing active translations", async () => {
    const firstBatch = createDeferred<TranslationResponse>();
    const secondBatch = createDeferred<TranslationResponse>();
    const firstRetouch = createDeferred<TranslationResponse>();
    const secondRetouch = createDeferred<TranslationResponse>();
    const pageBatches = [firstBatch, secondBatch, firstRetouch, secondRetouch];

    sendMessageMock.mockImplementation((message: RuntimeMessage) => {
      if (message.type === "TRANSLATE_PAGE_BLOCKS") {
        return pageBatches.shift()?.promise ?? Promise.resolve({
          ok: true,
          translations: [],
          meta: {
            cacheHits: 0,
            requestedCount: 0,
            networkCount: 0
          }
        });
      }

      return Promise.resolve({ ok: true });
    });
    document.body.innerHTML = `
      <main>
        <p>The API remains stable across versions and keeps clients compatible.</p>
        <p>This second English paragraph keeps the first visible batch full.</p>
        <p>This third English paragraph completes the initial visible translation batch.</p>
        <p>This fourth English paragraph should remain in the later background batch.</p>
      </main>
    `;

    await importContentModule();
    getImmersiveBubble().click();
    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => {
      expect(
        sendMessageMock.mock.calls.filter(
          ([message]) =>
            (message as RuntimeMessage).type === "TRANSLATE_PAGE_BLOCKS"
        )
      ).toHaveLength(1);
    });

    firstBatch.resolve({
      ok: true,
      translations: ["旧接口译文", "第二段译文", "第三段译文"],
      meta: {
        cacheHits: 0,
        requestedCount: 3,
        networkCount: 3
      }
    });

    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(3);
      expect(
        sendMessageMock.mock.calls.filter(
          ([message]) =>
            (message as RuntimeMessage).type === "TRANSLATE_PAGE_BLOCKS"
        )
      ).toHaveLength(2);
    });

    await dispatchContentMessage({
      type: "OPEN_GLOSSARY_TERM_EDITOR",
      payload: { text: "API" }
    });
    const editor = document.getElementById("litetrace-glossary-editor") as HTMLDivElement;
    const targetInput = editor.querySelector<HTMLInputElement>("input[name='target']");
    targetInput!.value = "接口";
    editor
      .querySelector<HTMLFormElement>(".litetrace-glossary-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(
        sendMessageMock.mock.calls.filter(
          ([message]) =>
            (message as RuntimeMessage).type === "TRANSLATE_PAGE_BLOCKS"
        )
      ).toHaveLength(3);
    });

    secondBatch.resolve({
      ok: true,
      translations: ["第四段译文"],
      meta: {
        cacheHits: 0,
        requestedCount: 1,
        networkCount: 1
      }
    });

    await vi.waitFor(() => {
      expect(
        sendMessageMock.mock.calls.filter(
          ([message]) =>
            (message as RuntimeMessage).type === "TRANSLATE_PAGE_BLOCKS"
        )
      ).toHaveLength(4);
      expect(getImmersiveBubble().dataset.state).toBe("active");
    });

    getImmersiveBubble().click();
    expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(0);

    firstRetouch.resolve({
      ok: true,
      translations: ["迟到的接口译文"],
      meta: {
        cacheHits: 0,
        requestedCount: 1,
        networkCount: 1
      }
    });
    secondRetouch.resolve({
      ok: true,
      translations: ["第二次迟到的接口译文"],
      meta: {
        cacheHits: 0,
        requestedCount: 1,
        networkCount: 1
      }
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(0);
    expect(getImmersiveBubble().dataset.state).toBe("idle");
  });
});
