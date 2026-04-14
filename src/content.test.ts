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
  let sendMessageMock: ReturnType<typeof vi.fn>;
  let storageStore: Record<string, unknown>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
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
          addListener: vi.fn()
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

  it("shows a trigger bubble for short english selections without auto-translating", async () => {
    document.body.innerHTML = `<p id="text">hello</p>`;

    await importContentModule();
    await showBubbleFor(document.getElementById("text") as HTMLElement);

    const bubble = document.getElementById("litetrace-selection-bubble") as HTMLButtonElement;
    expect(bubble.hidden).toBe(false);
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
    expect(document.querySelectorAll("#litetrace-selection-popup")).toHaveLength(1);
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
});
