import type { ExtensionStatus } from "./shared/types";

export type PopupMode = "unconfigured" | "ready" | "loading" | "active";

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
      title: "先接入你的大模型 API",
      description: "配置 OpenAI Compatible 后，术语库会帮助技术概念保持译法一致。",
      providerLine: "当前状态：未配置",
      hint: "Google Translate 也可作为备选。",
      primaryLabel: "去完成配置",
      secondaryLabel: undefined,
      disablePrimary: false
    };
  }

  if (status.activeTabImmersiveLoading) {
    const progress = status.activeTabImmersiveProgress;
    const progressLine = progress?.totalCount
      ? `已完成 ${progress.completedCount}/${progress.totalCount} 个段落，已插入 ${progress.insertedCount} 段中文对照。`
      : "正在扫描当前页面正文。";
    const cacheHint = progress?.cacheHits
      ? `已复用 ${progress.cacheHits} 段已有译文。`
      : "首批译文完成后会先插入页面。";

    return {
      mode: "loading",
      title: "正在生成双语对照",
      description: progressLine,
      providerLine: `当前接口：${status.providerLabel}`,
      hint: cacheHint,
      primaryLabel: "停止生成",
      secondaryLabel: "打开设置",
      disablePrimary: !status.activeTabSupported
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
    title: "可以开始技术双语阅读",
    description: status.hasCompletedSetup
      ? "当前配置已可用，术语库会在命中时参与 LLM 翻译。"
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
