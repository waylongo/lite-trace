import {
  collectTranslatableBlocks,
  groupTranslatableBlocks,
  isEditableNode,
  isTranslatableEnglishText,
  normalizeText
} from "./shared/content-helpers";
import { chunkTextLikeItems } from "./shared/batching";
import {
  applyImmersiveTranslations,
  clearImmersiveTranslations,
  hasImmersiveTranslations
} from "./shared/immersive";
import type {
  GroupedTranslatableBlocks,
  ReadingCoachmarkStatus,
  RuntimeMessage,
  TranslatableBlock,
  TranslationResponse
} from "./shared/types";

const STYLE_ID = "litetrace-inline-style";
const POPUP_ID = "litetrace-selection-popup";
const TOAST_ID = "litetrace-toast";

let lastPointer = { x: 0, y: 0 };
let popupEl: HTMLDivElement | null = null;
let selectionTimer: number | null = null;
let requestSequence = 0;
let popupInteraction = false;
let toastTimer: number | null = null;
let immersiveJobId = 0;
let immersiveLoading = false;

interface ImmersiveFailureState {
  message: string;
  action?: "open-options";
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .litetrace-immersive-translation {
      margin: 0.45rem 0 1rem;
      padding: 0.7rem 0.95rem;
      border-left: 3px solid #0b6e4f;
      border-radius: 0 14px 14px 0;
      background: linear-gradient(135deg, rgba(242, 250, 245, 0.98), rgba(232, 244, 255, 0.95));
      color: #123524;
      font-size: 0.95em;
      line-height: 1.8;
      box-shadow: 0 8px 22px rgba(8, 63, 44, 0.08);
    }

    #${POPUP_ID} {
      position: fixed;
      z-index: 2147483647;
      width: min(360px, calc(100vw - 24px));
      border-radius: 18px;
      border: 1px solid rgba(7, 58, 45, 0.16);
      background: rgba(252, 255, 252, 0.98);
      box-shadow: 0 18px 48px rgba(9, 49, 37, 0.2);
      backdrop-filter: blur(12px);
      color: #18352a;
      overflow: hidden;
      font-family: "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
    }

    #${POPUP_ID}[hidden] {
      display: none;
    }

    .litetrace-popup-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px 10px;
      background: linear-gradient(135deg, #eff8f3, #edf4ff);
      border-bottom: 1px solid rgba(7, 58, 45, 0.08);
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #406051;
    }

    .litetrace-popup-title {
      font-weight: 700;
    }

    .litetrace-popup-close,
    .litetrace-popup-action,
    .litetrace-popup-copy {
      border: 0;
      cursor: pointer;
      font: inherit;
    }

    .litetrace-popup-close {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: rgba(7, 58, 45, 0.08);
      color: #26463b;
    }

    .litetrace-popup-body {
      padding: 14px;
      font-size: 14px;
      line-height: 1.75;
      white-space: pre-wrap;
    }

    .litetrace-popup-meta {
      padding: 0 14px 14px;
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }

    .litetrace-popup-copy,
    .litetrace-popup-action {
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
    }

    .litetrace-popup-copy {
      color: #1b4d3f;
      background: rgba(14, 108, 79, 0.1);
    }

    .litetrace-popup-action {
      color: white;
      background: linear-gradient(135deg, #0a6f51, #2767a7);
    }

    #${TOAST_ID} {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483647;
      min-width: 220px;
      max-width: min(420px, calc(100vw - 24px));
      padding: 14px 16px;
      border-radius: 16px;
      background: rgba(18, 32, 26, 0.94);
      color: #f8fff9;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.2);
      font-family: "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
      white-space: pre-line;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    #${TOAST_ID}[hidden] {
      display: none;
    }

    .litetrace-toast-action {
      margin-left: auto;
      border: 0;
      background: rgba(255, 255, 255, 0.12);
      color: inherit;
      border-radius: 999px;
      padding: 7px 11px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 700;
    }
  `;

  document.documentElement.append(style);
}

function getPopup(): HTMLDivElement {
  if (popupEl) {
    return popupEl;
  }

  popupEl = document.createElement("div");
  popupEl.id = POPUP_ID;
  popupEl.hidden = true;
  popupEl.innerHTML = `
    <div class="litetrace-popup-header">
      <span class="litetrace-popup-title">浅译划词翻译</span>
      <button class="litetrace-popup-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="litetrace-popup-body"></div>
    <div class="litetrace-popup-meta"></div>
  `;

  popupEl.addEventListener("mousedown", () => {
    popupInteraction = true;
    window.setTimeout(() => {
      popupInteraction = false;
    }, 0);
  });

  popupEl
    .querySelector<HTMLButtonElement>(".litetrace-popup-close")
    ?.addEventListener("click", () => {
      hidePopup();
    });

  document.documentElement.append(popupEl);
  return popupEl;
}

function getToast(): HTMLDivElement {
  let toast = document.getElementById(TOAST_ID) as HTMLDivElement | null;

  if (toast) {
    return toast;
  }

  toast = document.createElement("div");
  toast.id = TOAST_ID;
  toast.hidden = true;
  document.documentElement.append(toast);
  return toast;
}

async function openOptionsPage(): Promise<void> {
  await chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
}

async function maybeShowReadingCoachmark(): Promise<void> {
  const status = (await chrome.runtime.sendMessage({
    type: "GET_READING_COACHMARK_STATUS"
  } satisfies RuntimeMessage)) as ReadingCoachmarkStatus;

  if (!status.shouldShow) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: "MARK_READING_COACHMARK_SEEN"
  } satisfies RuntimeMessage);

  showToast(
    "当前页面已经切换为双语阅读。\n再次点击插件可关闭，划词可查看局部翻译。",
    undefined,
    undefined,
    6200
  );
}

function showToast(
  message: string,
  actionLabel?: string,
  action?: () => void,
  durationMs = 3600
): void {
  const toast = getToast();
  toast.innerHTML = "";

  const text = document.createElement("div");
  text.textContent = message;
  toast.append(text);

  if (actionLabel && action) {
    const button = document.createElement("button");
    button.className = "litetrace-toast-action";
    button.type = "button";
    button.textContent = actionLabel;
    button.addEventListener("click", action);
    toast.append(button);
  }

  toast.hidden = false;

  if (toastTimer) {
    window.clearTimeout(toastTimer);
    toastTimer = null;
  }

  if (durationMs > 0) {
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
      toastTimer = null;
    }, durationMs);
  }
}

function hideToast(): void {
  const toast = getToast();
  toast.hidden = true;

  if (toastTimer) {
    window.clearTimeout(toastTimer);
    toastTimer = null;
  }
}

function hidePopup(): void {
  if (popupEl) {
    popupEl.hidden = true;
  }
}

function positionPopup(target: HTMLElement, rect: DOMRect | null): void {
  const width = Math.min(360, window.innerWidth - 24);
  const fallbackLeft = Math.max(12, Math.min(lastPointer.x - width / 2, window.innerWidth - width - 12));
  const left = rect
    ? Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12))
    : fallbackLeft;

  const preferredTop = rect ? rect.bottom + 12 : lastPointer.y + 12;
  const top = Math.min(preferredTop, window.innerHeight - 24);

  target.style.left = `${left}px`;
  target.style.top = `${Math.max(12, top)}px`;
}

function renderPopup(
  body: string,
  options?: {
    actionLabel?: string;
    action?: () => void;
    showCopy?: boolean;
    rect?: DOMRect | null;
  }
): void {
  const popup = getPopup();
  const bodyEl = popup.querySelector(".litetrace-popup-body");
  const metaEl = popup.querySelector(".litetrace-popup-meta");

  if (!bodyEl || !metaEl) {
    return;
  }

  bodyEl.textContent = body;
  metaEl.innerHTML = "";

  if (options?.showCopy) {
    const copyButton = document.createElement("button");
    copyButton.className = "litetrace-popup-copy";
    copyButton.type = "button";
    copyButton.textContent = "复制译文";
    copyButton.addEventListener("click", async () => {
      await navigator.clipboard.writeText(body);
      showToast("译文已复制到剪贴板。");
    });
    metaEl.append(copyButton);
  }

  if (options?.actionLabel && options.action) {
    const actionButton = document.createElement("button");
    actionButton.className = "litetrace-popup-action";
    actionButton.type = "button";
    actionButton.textContent = options.actionLabel;
    actionButton.addEventListener("click", options.action);
    metaEl.append(actionButton);
  }

  positionPopup(popup, options?.rect ?? null);
  popup.hidden = false;
}

function getSelectionRect(selection: Selection): DOMRect | null {
  if (selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  if (rect.width > 0 || rect.height > 0) {
    return rect;
  }

  const rects = range.getClientRects();
  return rects[0] ?? null;
}

async function requestTranslation(texts: string[]): Promise<TranslationResponse> {
  return chrome.runtime.sendMessage({
    type: texts.length > 1 ? "TRANSLATE_PAGE_BLOCKS" : "TRANSLATE_SELECTION",
    payload: { texts }
  } satisfies RuntimeMessage);
}

function applyGroupedTranslations(
  blocks: TranslatableBlock[],
  groups: GroupedTranslatableBlocks[],
  translations: string[]
): number {
  const expandedBlocks: TranslatableBlock[] = [];
  const expandedTranslations: string[] = [];

  groups.forEach((group, index) => {
    const translation = translations[index]?.trim();

    if (!translation) {
      return;
    }

    group.blockIndexes.forEach((blockIndex) => {
      const block = blocks[blockIndex];

      if (!block) {
        return;
      }

      expandedBlocks.push(block);
      expandedTranslations.push(translation);
    });
  });

  return applyImmersiveTranslations(expandedBlocks, expandedTranslations);
}

async function toggleImmersiveTranslation(): Promise<void> {
  if (immersiveLoading) {
    immersiveJobId += 1;
    immersiveLoading = false;
    showToast("已停止当前页面的双语阅读生成。");
    return;
  }

  if (hasImmersiveTranslations(document)) {
    const removedCount = clearImmersiveTranslations(document);
    showToast(
      removedCount > 0
        ? "当前页面已恢复为原始阅读状态。"
        : "当前页面没有需要关闭的双语对照。"
    );
    return;
  }

  const blocks = collectTranslatableBlocks(document);

  if (blocks.length === 0) {
    showToast("当前页面没有识别到可处理的英文正文。");
    return;
  }

  const groupedBlocks = groupTranslatableBlocks(blocks);
  const batches = chunkTextLikeItems(groupedBlocks, {
    maxItems: 8,
    maxChars: 4_200
  });
  const batchConcurrency = Math.min(3, batches.length);
  const currentJobId = ++immersiveJobId;
  immersiveLoading = true;
  let appliedCount = 0;
  let completedUniqueCount = 0;
  let cacheHitCount = 0;
  let inflightCount = 0;
  let nextBatchIndex = 0;
  let failure: ImmersiveFailureState | null = null;

  const updateImmersiveProgress = (): void => {
    showToast(
      `正在为当前页面生成双语阅读…\n已完成 ${completedUniqueCount}/${groupedBlocks.length} 个段落，已插入 ${appliedCount} 段中文对照。`,
      undefined,
      undefined,
      0
    );
  };

  try {
    updateImmersiveProgress();

    async function runBatchWorker(): Promise<void> {
      while (currentJobId === immersiveJobId && !failure) {
        const batchIndex = nextBatchIndex;
        const batch = batches[batchIndex];

        if (!batch) {
          return;
        }

        nextBatchIndex += 1;
        inflightCount += 1;
        updateImmersiveProgress();

        try {
          let response: TranslationResponse;

          try {
            response = await requestTranslation(batch.map((group) => group.text));
          } catch {
            failure = {
              message: "生成双语阅读时中途断开了，请重新点击扩展图标再试一次。"
            };
            return;
          }

          if (currentJobId !== immersiveJobId || failure) {
            return;
          }

          if (!response.ok) {
            failure = {
              message: `这次没能完成双语阅读：${response.error.message}`,
              action: response.error.action
            };
            return;
          }

          appliedCount += applyGroupedTranslations(
            blocks,
            batch,
            response.translations
          );
          completedUniqueCount += batch.length;
          cacheHitCount += response.meta?.cacheHits ?? 0;
        } finally {
          inflightCount = Math.max(0, inflightCount - 1);

          if (
            currentJobId === immersiveJobId &&
            !failure &&
            (completedUniqueCount < groupedBlocks.length || inflightCount > 0)
          ) {
            updateImmersiveProgress();
          }
        }
      }
    }

    await Promise.all(
      Array.from({ length: batchConcurrency }, () => runBatchWorker())
    );

    if (currentJobId !== immersiveJobId) {
      return;
    }

    const failedState = failure as ImmersiveFailureState | null;

    if (failedState) {
      showToast(
        failedState.message,
        failedState.action === "open-options" ? "打开设置" : undefined,
        failedState.action === "open-options" ? openOptionsPage : undefined,
        5200
      );
      return;
    }

    if (appliedCount === 0) {
      showToast("当前接口返回了异常结果，这一页暂时没能生成双语对照。");
      return;
    }

    if (cacheHitCount > 0) {
      showToast(
        `当前页面已经切换成双语阅读。\n本次优先复用了 ${cacheHitCount} 段已有译文，所以响应会更快。`
      );
    } else {
      showToast("当前页面已经切换成双语阅读。");
    }

    await maybeShowReadingCoachmark();
  } finally {
    if (currentJobId === immersiveJobId) {
      immersiveLoading = false;
    }
  }
}

function shouldKeepPopup(selectionText: string): boolean {
  return normalizeText(selectionText).length > 0;
}

async function translateCurrentSelection(): Promise<void> {
  const selection = window.getSelection();

  if (!selection || selection.isCollapsed || !shouldKeepPopup(selection.toString())) {
    hidePopup();
    return;
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;

  if (isEditableNode(anchorNode) || isEditableNode(focusNode)) {
    hidePopup();
    return;
  }

  const text = normalizeText(selection.toString());
  if (!isTranslatableEnglishText(text)) {
    hidePopup();
    return;
  }

  const rect = getSelectionRect(selection);
  renderPopup("正在理解这段英文，并生成附近可直接查看的中文对照…", { rect });

  const sequence = ++requestSequence;
  let response: TranslationResponse;

  try {
    response = await requestTranslation([text]);
  } catch {
    renderPopup("这次没有成功返回译文，请重试，或刷新页面后再试。", { rect });
    return;
  }

  if (sequence !== requestSequence) {
    return;
  }

  if (!response.ok) {
    renderPopup(response.error.message, {
      rect,
      actionLabel: response.error.action === "open-options" ? "打开设置" : undefined,
      action:
        response.error.action === "open-options"
          ? openOptionsPage
          : undefined
    });
    return;
  }

  renderPopup(response.translations[0], {
    rect,
    showCopy: true
  });
}

function scheduleSelectionTranslation(): void {
  if (selectionTimer) {
    window.clearTimeout(selectionTimer);
  }

  selectionTimer = window.setTimeout(() => {
    void translateCurrentSelection();
  }, 180);
}

function handleSelectionChange(): void {
  const selection = window.getSelection();

  if (popupInteraction) {
    return;
  }

  if (!selection || selection.isCollapsed) {
    hidePopup();
    hideToast();
  }
}

function handleDocumentMouseDown(event: MouseEvent): void {
  const popup = getPopup();
  if (!popup.hidden && event.target instanceof Node && !popup.contains(event.target)) {
    hidePopup();
  }
}

function initialize(): void {
  injectStyles();
  getPopup();
  getToast();

  document.addEventListener("mouseup", (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
    scheduleSelectionTranslation();
  });

  document.addEventListener("selectionchange", handleSelectionChange);
  document.addEventListener("mousedown", handleDocumentMouseDown, true);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hidePopup();
    }
  });
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "TOGGLE_IMMERSIVE_TRANSLATION") {
    void toggleImmersiveTranslation()
      .catch(() => {
        showToast("当前页面的双语阅读切换失败了，请稍后重试。");
      })
      .finally(() => {
        sendResponse({ ok: true });
      });
    return true;
  }

  if (message.type === "GET_PAGE_IMMERSIVE_STATE") {
    sendResponse({
      ok: true,
      immersiveActive: hasImmersiveTranslations(document)
    });
    return true;
  }

  if ((message as { type?: string }).type === "PING") {
    sendResponse({ ok: true });
  }

  return false;
});

if (!(window as Window & { __litetraceInitialized?: boolean }).__litetraceInitialized) {
  (window as Window & { __litetraceInitialized?: boolean }).__litetraceInitialized = true;
  initialize();
}
