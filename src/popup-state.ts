import type { ExtensionStatus } from "./shared/types";

export type PopupMode = "unconfigured" | "ready" | "active";

export interface PopupViewModel {
  mode: PopupMode;
  title: string;
  description: string;
  providerLine: string;
  hint: string;
  primaryLabel: string;
  secondaryLabel?: string;
  disablePrimary: boolean;
}

export function derivePopupViewModel(status: ExtensionStatus): PopupViewModel {
  if (!status.configured) {
    return {
      mode: "unconfigured",
      title: "先完成接口配置",
      description: "配置好后，点击图标就能开启双语阅读。",
      providerLine: "当前状态：未配置",
      hint: "需要使用你自己的翻译接口。",
      primaryLabel: "去完成配置",
      secondaryLabel: undefined,
      disablePrimary: false
    };
  }

  if (status.activeTabImmersiveActive) {
    return {
      mode: "active",
      title: "当前页已开启双语",
      description: "再次点击即可关闭。",
      providerLine: `当前接口：${status.providerLabel}`,
      hint: "划词可查看局部译文。",
      primaryLabel: "关闭双语对照",
      secondaryLabel: "打开设置",
      disablePrimary: !status.activeTabSupported
    };
  }

  return {
    mode: "ready",
    title: "可以开始沉浸阅读",
    description: status.hasCompletedSetup
      ? "当前配置已可用。"
      : "配置已保存，建议先验证一次。",
    providerLine: `当前接口：${status.providerLabel}`,
    hint: status.activeTabSupported
      ? "点击后会作用于当前标签页。"
      : "请先切换到普通网页标签页。",
    primaryLabel: "开始沉浸阅读",
    secondaryLabel: "打开设置",
    disablePrimary: !status.activeTabSupported
  };
}
