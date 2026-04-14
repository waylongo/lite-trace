import type {
  GroupedTranslatableBlocks,
  TranslatableBlock
} from "./types";

const MIN_TRANSLATABLE_LENGTH = 18;
const MIN_TRANSLATABLE_HEADING_LENGTH = 6;
const MAX_TRANSLATABLE_LENGTH = 1_800;
const MAX_SELECTION_TRANSLATABLE_LENGTH = 600;
const MIN_ENGLISH_RATIO = 0.45;
const TARGET_TAGS = new Set([
  "P",
  "LI",
  "BLOCKQUOTE",
  "FIGCAPTION",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6"
]);
const ROOT_SELECTORS = ["article", "main", "[role='main']"] as const;
const TARGET_TAG_SELECTOR = Array.from(TARGET_TAGS)
  .map((tagName) => tagName.toLowerCase())
  .join(",");

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

function isHeadingTag(tagName: string): boolean {
  return /^H[1-6]$/.test(tagName);
}

export function isTranslatableBlockText(
  element: HTMLElement,
  text: string
): boolean {
  const normalized = normalizeText(text);
  const minLength = isHeadingTag(element.tagName)
    ? MIN_TRANSLATABLE_HEADING_LENGTH
    : MIN_TRANSLATABLE_LENGTH;

  if (
    normalized.length < minLength ||
    normalized.length > MAX_TRANSLATABLE_LENGTH
  ) {
    return false;
  }

  return calculateEnglishRatio(normalized) >= MIN_ENGLISH_RATIO;
}

export function isTranslatableSelectionText(text: string): boolean {
  const normalized = normalizeText(text);

  if (!normalized || normalized.length > MAX_SELECTION_TRANSLATABLE_LENGTH) {
    return false;
  }

  return /[A-Za-z]/.test(normalized);
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

function hasNestedTargetBlock(element: HTMLElement): boolean {
  return Boolean(element.querySelector(TARGET_TAG_SELECTOR));
}

interface ScanRoot {
  element: HTMLElement;
  priority: number;
}

function getQueryRoot(root: ParentNode): ParentNode | null {
  if (root instanceof Document) {
    return root;
  }

  return root instanceof HTMLElement ? root : null;
}

function collectPreferredRoots(root: ParentNode): ScanRoot[] {
  const queryRoot = getQueryRoot(root);

  if (!queryRoot) {
    return [];
  }

  const candidates: ScanRoot[] = [];

  ROOT_SELECTORS.forEach((selector, priority) => {
    if (queryRoot instanceof HTMLElement && queryRoot.matches(selector)) {
      candidates.push({
        element: queryRoot,
        priority
      });
    }

    candidates.push(
      ...Array.from(queryRoot.querySelectorAll<HTMLElement>(selector)).map((element) => ({
        element,
        priority
      }))
    );
  });

  const selected: ScanRoot[] = [];
  const seen = new Set<HTMLElement>();

  for (const candidate of candidates) {
    if (seen.has(candidate.element)) {
      continue;
    }

    seen.add(candidate.element);

    if (selected.some((rootCandidate) => rootCandidate.element.contains(candidate.element))) {
      continue;
    }

    selected.push(candidate);
  }

  selected.sort((left, right) => {
    const position = left.element.compareDocumentPosition(right.element);

    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }

    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }

    return left.priority - right.priority;
  });

  return selected;
}

function getFallbackRoot(root: ParentNode): HTMLElement | null {
  if (root instanceof Document) {
    return root.body;
  }

  return root instanceof HTMLElement ? root : null;
}

function isClaimedByHigherPriorityRoot(
  element: HTMLElement,
  currentRoot: ScanRoot,
  roots: ScanRoot[]
): boolean {
  return roots.some((rootCandidate) => {
    if (rootCandidate.element === currentRoot.element) {
      return false;
    }

    if (!currentRoot.element.contains(rootCandidate.element)) {
      return false;
    }

    if (!rootCandidate.element.contains(element)) {
      return false;
    }

    if (rootCandidate.priority !== currentRoot.priority) {
      return rootCandidate.priority < currentRoot.priority;
    }

    return true;
  });
}

export function collectTranslatableBlocks(
  root: ParentNode = document
): TranslatableBlock[] {
  const preferredRoots = collectPreferredRoots(root);
  const scanRoots =
    preferredRoots.length > 0
      ? preferredRoots
      : (() => {
          const fallbackRoot = getFallbackRoot(root);
          return fallbackRoot
            ? [
                {
                  element: fallbackRoot,
                  priority: ROOT_SELECTORS.length
                }
              ]
            : [];
        })();
  const seen = new Set<HTMLElement>();
  const blocks: TranslatableBlock[] = [];

  for (const scanRoot of scanRoots) {
    const walker = scanRoot.element.ownerDocument.createTreeWalker(
      scanRoot.element,
      NodeFilter.SHOW_ELEMENT
    );

    let currentNode: Node | null = walker.currentNode;

    while (currentNode) {
      if (currentNode instanceof HTMLElement) {
        const element = currentNode;

        if (
          TARGET_TAGS.has(element.tagName) &&
          !seen.has(element) &&
          !hasNestedTargetBlock(element) &&
          !isClaimedByHigherPriorityRoot(element, scanRoot, scanRoots)
        ) {
          seen.add(element);

          if (!isSkippableElement(element) && isVisibleElement(element)) {
            const text = normalizeText(element.textContent ?? "");

            if (text && isTranslatableBlockText(element, text)) {
              blocks.push({ element, text });
            }
          }
        }
      }

      currentNode = walker.nextNode() ?? null;
    }
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
