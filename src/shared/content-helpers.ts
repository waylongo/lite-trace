import type {
  GroupedTranslatableBlocks,
  TranslatableBlock
} from "./types";

const MIN_TRANSLATABLE_LENGTH = 18;
const MAX_TRANSLATABLE_LENGTH = 1_800;
const MIN_ENGLISH_RATIO = 0.45;

const BLOCK_SELECTORS = [
  "article p",
  "article li",
  "article blockquote",
  "article figcaption",
  "article h1",
  "article h2",
  "article h3",
  "article h4",
  "article h5",
  "article h6",
  "main p",
  "main li",
  "main blockquote",
  "main figcaption",
  "main h1",
  "main h2",
  "main h3",
  "main h4",
  "main h5",
  "main h6",
  "body p",
  "body li",
  "body blockquote",
  "body figcaption",
  "body h1",
  "body h2",
  "body h3",
  "body h4",
  "body h5",
  "body h6"
];

const SKIP_SELECTOR = [
  "script",
  "style",
  "noscript",
  "pre",
  "code",
  "textarea",
  "input",
  "button",
  "select",
  "option",
  "nav",
  "header",
  "footer",
  "aside",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[data-litetrace-translation]"
].join(",");

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function calculateEnglishRatio(text: string): number {
  const latinCharacters = text.match(/[A-Za-z]/g) ?? [];
  const letterCharacters = text.match(/[A-Za-z\u00C0-\u024F\u4E00-\u9FFF]/g) ?? [];

  if (letterCharacters.length === 0) {
    return 0;
  }

  return latinCharacters.length / letterCharacters.length;
}

export function isTranslatableEnglishText(text: string): boolean {
  const normalized = normalizeText(text);

  if (
    normalized.length < MIN_TRANSLATABLE_LENGTH ||
    normalized.length > MAX_TRANSLATABLE_LENGTH
  ) {
    return false;
  }

  return calculateEnglishRatio(normalized) >= MIN_ENGLISH_RATIO;
}

export function isVisibleElement(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getAttribute("aria-hidden") !== "true"
  );
}

export function isEditableNode(node: Node | null): boolean {
  if (!node) {
    return false;
  }

  const element =
    node instanceof HTMLElement ? node : node.parentElement ?? undefined;

  return Boolean(
    element?.closest(
      "input, textarea, select, option, [contenteditable=''], [contenteditable='true']"
    )
  );
}

export function isSkippableElement(element: HTMLElement): boolean {
  return Boolean(element.closest(SKIP_SELECTOR));
}

export function collectTranslatableBlocks(
  root: ParentNode = document
): TranslatableBlock[] {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(BLOCK_SELECTORS.join(","))
  );
  const seen = new Set<HTMLElement>();
  const blocks: TranslatableBlock[] = [];

  for (const element of candidates) {
    if (seen.has(element)) {
      continue;
    }

    seen.add(element);

    if (!isVisibleElement(element) || isSkippableElement(element)) {
      continue;
    }

    const text = normalizeText(element.innerText || element.textContent || "");

    if (!isTranslatableEnglishText(text)) {
      continue;
    }

    blocks.push({ element, text });
  }

  return blocks;
}

export function groupTranslatableBlocks(
  blocks: TranslatableBlock[]
): GroupedTranslatableBlocks[] {
  const groups = new Map<string, GroupedTranslatableBlocks>();

  blocks.forEach((block, index) => {
    const key = normalizeText(block.text);
    const existing = groups.get(key);

    if (existing) {
      existing.blockIndexes.push(index);
      return;
    }

    groups.set(key, {
      text: block.text,
      blockIndexes: [index]
    });
  });

  return Array.from(groups.values());
}
