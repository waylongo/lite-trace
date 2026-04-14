import {
  collectTranslatableBlocks,
  groupTranslatableBlocks,
  isEditableNode,
  isTranslatableSelectionText,
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
const BUBBLE_ID = "litetrace-selection-bubble";
const POPUP_ID = "litetrace-selection-popup";
const TOAST_ID = "litetrace-toast";
const CONTENT_RUNTIME_FLAG = "__litetraceInitialized";

let lastPointer = { x: 0, y: 0 };
let bubbleEl: HTMLButtonElement | null = null;
let popupEl: HTMLDivElement | null = null;
let toastEl: HTMLDivElement | null = null;
let selectionTimer: number | null = null;
let requestSequence = 0;
let uiInteraction = false;
let toastTimer: number | null = null;
let immersiveJobId = 0;
let immersiveLoading = false;
let activeSelection: SelectionSnapshot | null = null;

interface ImmersiveFailureState {
  message: string;
  action?: "open-options";
}

interface SelectionSnapshot {
  text: string;
  rect: DOMRect | null;
  key: string;
  fallbackPlacement?: "pointer" | "viewport-top-right";
}

type LiteTraceWindow = Window & {
  [CONTENT_RUNTIME_FLAG]?: boolean;
};

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .litetrace-immersive-translation {
      color: inherit;
      margin-block-start: 0 !important;
    }

    [data-litetrace-source] {
      margin-block-end: 0.14em !important;
    }

    [data-litetrace-source]:is(h1, h2, h3, h4, h5, h6) {
      margin-block-end: 0.06em !important;
    }

    .litetrace-immersive-translation:is(h1, h2, h3, h4, h5, h6) {
      margin-block-start: 0 !important;
    }

    #${BUBBLE_ID} {
      position: fixed;
      z-index: 2147483647;
      min-width: 68px;
      height: 38px;
      padding: 0 14px;
      border: 0;
      border-radius: 999px;
      background: linear-gradient(135deg, #0a6f51, #2767a7);
      color: white;
      box-shadow: 0 14px 32px rgba(9, 49, 37, 0.22);
      font: inherit;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
    }

    #${BUBBLE_ID}[hidden] {
      display: none;
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

function markUiInteraction(): void {
  uiInteraction = true;
  window.setTimeout(() => {
    uiInteraction = false;
  }, 0);
}

function getBubble(): HTMLButtonElement {
  if (bubbleEl) {
    return bubbleEl;
  }

  const existing = document.getElementById(BUBBLE_ID) as HTMLButtonElement | null;

  if (existing) {
    bubbleEl = existing;
    return bubbleEl;
  }

  bubbleEl = document.createElement("button");
  bubbleEl.id = BUBBLE_ID;
  bubbleEl.type = "button";
  bubbleEl.hidden = true;
  bubbleEl.textContent = "浅译";

  bubbleEl.addEventListener("mousedown", (event) => {
    event.preventDefault();
    markUiInteraction();
  });

  bubbleEl.addEventListener("click", () => {
    if (!activeSelection) {
      return;
    }

    void translateSelectionSnapshot(activeSelection);
  });

  document.documentElement.append(bubbleEl);
  return bubbleEl;
}

function getPopup(): HTMLDivElement {
  if (popupEl) {
    return popupEl;
  }

  const existing = document.getElementById(POPUP_ID) as HTMLDivElement | null;

  if (existing) {
    popupEl = existing;
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
    markUiInteraction();
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
  if (toastEl) {
    return toastEl;
  }

  let toast = document.getElementById(TOAST_ID) as HTMLDivElement | null;

  if (toast) {
    toastEl = toast;
    return toastEl;
  }

  toast = document.createElement("div");
  toast.id = TOAST_ID;
  toast.hidden = true;
  document.documentElement.append(toast);
  toastEl = toast;
  return toastEl;
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

function hideBubble(): void {
  if (bubbleEl) {
    bubbleEl.hidden = true;
  }
}

function positionPopup(
  target: HTMLElement,
  rect: DOMRect | null,
  fallbackPlacement: "pointer" | "viewport-top-right" = "pointer"
): void {
  const width = Math.min(360, window.innerWidth - 24);
  const fallbackLeft =
    fallbackPlacement === "viewport-top-right"
      ? window.innerWidth - width - 12
      : Math.max(
          12,
          Math.min(lastPointer.x - width / 2, window.innerWidth - width - 12)
        );
  const left = rect
    ? Math.max(
        12,
        Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12)
      )
    : fallbackLeft;

  const preferredTop =
    rect
      ? rect.bottom + 12
      : fallbackPlacement === "viewport-top-right"
        ? 12
        : lastPointer.y + 12;
  const top = Math.min(preferredTop, window.innerHeight - 24);

  target.style.left = `${left}px`;
  target.style.top = `${Math.max(12, top)}px`;
}

function positionBubble(target: HTMLButtonElement, rect: DOMRect | null): void {
  const width = 68;
  const height = 38;
  const left = rect
    ? Math.max(
        12,
        Math.min(rect.right - width / 2, window.innerWidth - width - 12)
      )
    : Math.max(12, Math.min(lastPointer.x - width / 2, window.innerWidth - width - 12));
  const top = rect
    ? Math.max(12, rect.top - height - 10)
    : Math.max(12, lastPointer.y - height - 10);

  target.style.left = `${left}px`;
  target.style.top = `${top}px`;
}

function renderPopup(
  body: string,
  options?: {
    actionLabel?: string;
    action?: () => void;
    showCopy?: boolean;
    rect?: DOMRect | null;
    fallbackPlacement?: "pointer" | "viewport-top-right";
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

  positionPopup(popup, options?.rect ?? null, options?.fallbackPlacement);
  popup.hidden = false;
}

function renderBubble(snapshot: SelectionSnapshot): void {
  const bubble = getBubble();
  positionBubble(bubble, snapshot.rect);
  bubble.hidden = false;
}

function clearSelectionUi(): void {
  requestSequence += 1;
  activeSelection = null;
  hideBubble();
  hidePopup();
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

function isSameRect(left: DOMRect | null, right: DOMRect | null): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

function isSameSelectionSnapshot(
  left: SelectionSnapshot | null,
  right: SelectionSnapshot | null
): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    left.text === right.text &&
    left.fallbackPlacement === right.fallbackPlacement &&
    isSameRect(left.rect, right.rect)
  );
}

function createSelectionSnapshot(selection: Selection): SelectionSnapshot | null {
  if (selection.isCollapsed) {
    return null;
  }

  if (isEditableNode(selection.anchorNode) || isEditableNode(selection.focusNode)) {
    return null;
  }

  const text = normalizeText(selection.toString());

  if (!isTranslatableSelectionText(text)) {
    return null;
  }

  return {
    text,
    rect: getSelectionRect(selection),
    key: text
  };
}

function createFallbackSelectionSnapshot(text?: string): SelectionSnapshot | null {
  const normalized = normalizeText(text ?? "");

  if (!isTranslatableSelectionText(normalized)) {
    return null;
  }

  return {
    text: normalized,
    rect: null,
    key: `fallback:${normalized}`,
    fallbackPlacement: "viewport-top-right"
  };
}

async function requestTranslation(texts: string[]): Promise<TranslationResponse> {
  return chrome.runtime.sendMessage({
    type: texts.length > 1 ? "TRANSLATE_PAGE_BLOCKS" : "TRANSLATE_SELECTION",
    payload: {
      texts,
      scene: texts.length > 1 ? "page" : "selection"
    }
  } satisfies RuntimeMessage);
}

async function requestPageTranslation(
  texts: string[],
  immersiveJobId: number
): Promise<TranslationResponse> {
  return chrome.runtime.sendMessage({
    type: "TRANSLATE_PAGE_BLOCKS",
    payload: {
      texts,
      scene: "page",
      immersiveJobId
    }
  } satisfies RuntimeMessage);
}

async function cancelImmersiveTranslation(immersiveJobId: number): Promise<void> {
  await chrome.runtime.sendMessage({
    type: "CANCEL_IMMERSIVE_TRANSLATION",
    payload: { immersiveJobId }
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
    const activeJobId = immersiveJobId;
    immersiveJobId += 1;
    immersiveLoading = false;
    void cancelImmersiveTranslation(activeJobId).catch(() => {
      // Ignore cancellation transport failures; stale responses are still gated by job id.
    });
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
            response = await requestPageTranslation(
              batch.map((group) => group.text),
              currentJobId
            );
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

async function translateSelectionSnapshot(snapshot: SelectionSnapshot): Promise<void> {
  activeSelection = snapshot;
  hideBubble();
  renderPopup("正在理解这段英文，并生成附近可直接查看的中文对照…", {
    rect: snapshot.rect,
    fallbackPlacement: snapshot.fallbackPlacement
  });

  const sequence = ++requestSequence;
  let response: TranslationResponse;

  try {
    response = await requestTranslation([snapshot.text]);
  } catch {
    if (sequence !== requestSequence || !isSameSelectionSnapshot(activeSelection, snapshot)) {
      return;
    }

    renderPopup("这次没有成功返回译文，请重试，或刷新页面后再试。", {
      rect: snapshot.rect,
      fallbackPlacement: snapshot.fallbackPlacement
    });
    return;
  }

  if (sequence !== requestSequence || !isSameSelectionSnapshot(activeSelection, snapshot)) {
    return;
  }

  if (!response.ok) {
    renderPopup(response.error.message, {
      rect: snapshot.rect,
      fallbackPlacement: snapshot.fallbackPlacement,
      actionLabel: response.error.action === "open-options" ? "打开设置" : undefined,
      action:
        response.error.action === "open-options"
          ? openOptionsPage
          : undefined
    });
    return;
  }

  renderPopup(response.translations[0], {
    rect: snapshot.rect,
    fallbackPlacement: snapshot.fallbackPlacement,
    showCopy: true
  });
}

async function triggerSelectionTranslationFromMessage(text?: string): Promise<void> {
  const currentSelection = window.getSelection();
  const snapshot =
    (currentSelection ? createSelectionSnapshot(currentSelection) : null) ??
    createFallbackSelectionSnapshot(text);

  if (!snapshot) {
    clearSelectionUi();
    renderPopup("这次没有检测到可翻译的英文内容，请重新选中后再试。", {
      fallbackPlacement: "viewport-top-right"
    });
    return;
  }

  activeSelection = snapshot;
  void translateSelectionSnapshot(snapshot);
}

async function updateSelectionUi(): Promise<void> {
  const selection = window.getSelection();
  const snapshot = selection ? createSelectionSnapshot(selection) : null;

  if (!snapshot) {
    clearSelectionUi();
    return;
  }

  const hasChanged = !isSameSelectionSnapshot(activeSelection, snapshot);
  activeSelection = snapshot;

  if (hasChanged) {
    hidePopup();
  } else if (popupEl?.hidden === false) {
    return;
  }

  renderBubble(snapshot);
}

function scheduleSelectionTranslation(): void {
  if (selectionTimer) {
    window.clearTimeout(selectionTimer);
  }

  selectionTimer = window.setTimeout(() => {
    void updateSelectionUi();
  }, 180);
}

function handleSelectionChange(): void {
  const selection = window.getSelection();

  if (uiInteraction) {
    return;
  }

  if (!selection || selection.isCollapsed) {
    clearSelectionUi();
  }
}

function handleDocumentMouseDown(event: MouseEvent): void {
  const popup = getPopup();
  const bubble = getBubble();

  if (
    event.target instanceof Node &&
    !popup.contains(event.target) &&
    !bubble.contains(event.target)
  ) {
    clearSelectionUi();
  }
}

function initialize(): void {
  injectStyles();
  getBubble();
  getPopup();
  getToast();

  document.addEventListener("mouseup", (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
    scheduleSelectionTranslation();
  });
  document.addEventListener("contextmenu", (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
  });

  document.addEventListener("selectionchange", handleSelectionChange);
  document.addEventListener("mousedown", handleDocumentMouseDown, true);
  window.addEventListener("scroll", () => {
    clearSelectionUi();
  }, true);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      clearSelectionUi();
    }
  });
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

    if (message.type === "TRIGGER_SELECTION_TRANSLATION") {
      void triggerSelectionTranslationFromMessage(message.payload?.text).finally(() => {
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.type === "PING") {
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });
}

const contentWindow = window as LiteTraceWindow;

// Recovery injection can execute the same content script more than once on a page.
if (!contentWindow[CONTENT_RUNTIME_FLAG]) {
  contentWindow[CONTENT_RUNTIME_FLAG] = true;
  initialize();
}
