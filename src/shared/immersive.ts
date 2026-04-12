import type { TranslatableBlock } from "./types";

export const TRANSLATION_SELECTOR = "[data-litetrace-translation]";

export function hasImmersiveTranslations(root: ParentNode = document): boolean {
  return Boolean(root.querySelector(TRANSLATION_SELECTOR));
}

export function clearImmersiveTranslations(root: ParentNode = document): number {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(TRANSLATION_SELECTOR));

  for (const node of nodes) {
    node.remove();
  }

  return nodes.length;
}

export function applyImmersiveTranslations(
  blocks: TranslatableBlock[],
  translations: string[]
): number {
  let appliedCount = 0;

  blocks.forEach((block, index) => {
    const translation = translations[index]?.trim();

    if (!translation) {
      return;
    }

    const existingSibling = block.element.nextElementSibling as HTMLElement | null;
    if (existingSibling?.matches(TRANSLATION_SELECTOR)) {
      existingSibling.textContent = translation;
      appliedCount += 1;
      return;
    }

    const node = document.createElement("div");
    node.dataset.litetraceTranslation = "true";
    node.className = "litetrace-immersive-translation";
    node.textContent = translation;
    block.element.insertAdjacentElement("afterend", node);
    appliedCount += 1;
  });

  return appliedCount;
}
