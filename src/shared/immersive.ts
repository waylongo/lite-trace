import type { TranslatableBlock } from "./types";

export const TRANSLATION_SELECTOR = "[data-litetrace-translation]";
export const SOURCE_SELECTOR = "[data-litetrace-source]";

const COPIED_ATTRIBUTES = [
  "class",
  "style",
  "dir",
  "lang",
  "title"
] as const;

function createTranslationElement(source: HTMLElement, translation: string): HTMLElement {
  const node = document.createElement(source.tagName.toLowerCase());
  node.dataset.litetraceTranslation = "true";
  node.classList.add("litetrace-immersive-translation");

  for (const attribute of COPIED_ATTRIBUTES) {
    const value = source.getAttribute(attribute);

    if (value) {
      node.setAttribute(attribute, value);
    }
  }

  node.removeAttribute("id");
  node.setAttribute("lang", "zh-CN");
  node.textContent = translation;
  return node;
}

export function hasImmersiveTranslations(root: ParentNode = document): boolean {
  return Boolean(root.querySelector(TRANSLATION_SELECTOR));
}

export function clearImmersiveTranslations(root: ParentNode = document): number {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(TRANSLATION_SELECTOR));
  const sources = Array.from(root.querySelectorAll<HTMLElement>(SOURCE_SELECTOR));

  for (const node of nodes) {
    node.remove();
  }

  for (const source of sources) {
    delete source.dataset.litetraceSource;
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

    block.element.dataset.litetraceSource = "true";

    const existingSibling = block.element.nextElementSibling as HTMLElement | null;
    if (existingSibling?.matches(TRANSLATION_SELECTOR)) {
      existingSibling.textContent = translation;
      appliedCount += 1;
      return;
    }

    const node = createTranslationElement(block.element, translation);
    block.element.insertAdjacentElement("afterend", node);
    appliedCount += 1;
  });

  return appliedCount;
}
