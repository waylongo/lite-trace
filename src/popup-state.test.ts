import { derivePopupViewModel } from "./popup-state";
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

describe("popup state", () => {
  it("derives the unconfigured state", () => {
    expect(
      derivePopupViewModel(
        buildStatus({
          configured: false
        })
      )
    ).toMatchObject({
      mode: "unconfigured",
      primaryLabel: "去完成配置"
    });
  });

  it("derives the ready state", () => {
    expect(derivePopupViewModel(buildStatus())).toMatchObject({
      mode: "ready",
      primaryLabel: "开始沉浸阅读"
    });
  });

  it("derives the active state", () => {
    expect(
      derivePopupViewModel(
        buildStatus({
          activeTabImmersiveActive: true
        })
      )
    ).toMatchObject({
      mode: "active",
      primaryLabel: "关闭双语对照"
    });
  });
});
