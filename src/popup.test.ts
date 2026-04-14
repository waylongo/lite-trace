import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionStatus } from "./shared/types";

function buildStatus(overrides?: Partial<ExtensionStatus>): ExtensionStatus {
  return {
    configured: true,
    providerLabel: "Google Translate API",
    hasCompletedSetup: true,
    activeTabSupported: true,
    activeTabImmersiveActive: false,
    ...overrides
  };
}

function renderPopupFixture(): void {
  document.body.innerHTML = `
    <div class="popup-shell">
      <section class="popup-card" id="popup-card">
        <div class="status-chip" id="status-chip">读取状态中…</div>
        <p class="provider-line" id="provider-line"></p>
        <p class="popup-description" id="popup-description"></p>
        <p class="popup-hint" id="popup-hint"></p>
        <button id="primary-button" type="button">稍候…</button>
        <button id="secondary-button" type="button" hidden>打开设置</button>
        <div id="popup-feedback"></div>
      </section>
    </div>
  `;
}

describe("popup runtime", () => {
  let sendMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    renderPopupFixture();
    sendMessageMock = vi.fn();

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: sendMessageMock,
        openOptionsPage: vi.fn().mockResolvedValue(undefined)
      }
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("keeps the primary action disabled for unsupported tabs after refresh", async () => {
    sendMessageMock.mockResolvedValue(
      buildStatus({
        activeTabSupported: false
      })
    );

    await import("./popup");

    await vi.waitFor(() => {
      expect(
        (document.getElementById("primary-button") as HTMLButtonElement).disabled
      ).toBe(true);
    });

    expect(document.getElementById("popup-feedback")?.textContent).toBe(
      "当前标签页暂不支持开启。"
    );
  });

  it("does not let the busy-state reset override a disabled business state", async () => {
    sendMessageMock
      .mockResolvedValueOnce(
        buildStatus({
          activeTabImmersiveActive: true
        })
      )
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(
        buildStatus({
          activeTabSupported: false,
          activeTabImmersiveActive: false
        })
      );

    await import("./popup");

    const primaryButton = document.getElementById(
      "primary-button"
    ) as HTMLButtonElement;

    await vi.waitFor(() => {
      expect(primaryButton.textContent).toBe("关闭双语对照");
    });

    primaryButton.click();

    await vi.waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: "TRIGGER_ACTIVE_TAB_IMMERSIVE"
      });
    });

    await vi.waitFor(() => {
      expect(primaryButton.disabled).toBe(true);
      expect(document.getElementById("popup-feedback")?.textContent).toBe("已关闭。");
    });
  });
});
