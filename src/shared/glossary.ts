import type { GlossaryTerm } from "./types";

export const GLOSSARY_STORAGE_KEY = "litetrace.glossary.terms";
export const GLOSSARY_MAX_TERMS = 500;
export const GLOSSARY_REQUEST_TERM_LIMIT = 50;

interface StoredGlossaryState {
  version: 1;
  terms: GlossaryTerm[];
}

export interface GlossaryTermInput {
  sourceText: string;
  targetText: string;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function normalizeGlossarySource(text: string): string {
  return normalizeWhitespace(text).toLocaleLowerCase();
}

function normalizeGlossaryTarget(text: string): string {
  return normalizeWhitespace(text);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAsciiWordCharacter(character: string): boolean {
  return /^[A-Za-z0-9_]$/.test(character);
}

function createGlossaryTermId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `term-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function sanitizeGlossaryTerm(value: unknown): GlossaryTerm | null {
  if (!isObject(value)) {
    return null;
  }

  const sourceText = normalizeWhitespace(
    typeof value.sourceText === "string" ? value.sourceText : ""
  );
  const targetText = normalizeGlossaryTarget(
    typeof value.targetText === "string" ? value.targetText : ""
  );

  if (!sourceText || !targetText || !/[A-Za-z]/.test(sourceText)) {
    return null;
  }

  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id : createGlossaryTermId(),
    sourceText,
    targetText,
    enabled: value.enabled !== false,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now()
  };
}

export function sanitizeGlossaryTerms(value: unknown): GlossaryTerm[] {
  const rawTerms = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value.terms)
      ? value.terms
      : [];
  const terms: GlossaryTerm[] = [];
  const seenSources = new Set<string>();

  for (const rawTerm of rawTerms) {
    const term = sanitizeGlossaryTerm(rawTerm);

    if (!term) {
      continue;
    }

    const sourceKey = normalizeGlossarySource(term.sourceText);

    if (seenSources.has(sourceKey)) {
      continue;
    }

    seenSources.add(sourceKey);
    terms.push(term);

    if (terms.length >= GLOSSARY_MAX_TERMS) {
      break;
    }
  }

  return terms;
}

async function readGlossaryState(): Promise<StoredGlossaryState> {
  const stored = await chrome.storage.local.get(GLOSSARY_STORAGE_KEY);
  const terms = sanitizeGlossaryTerms(stored[GLOSSARY_STORAGE_KEY]);

  return {
    version: 1,
    terms
  };
}

async function writeGlossaryTerms(terms: GlossaryTerm[]): Promise<void> {
  await chrome.storage.local.set({
    [GLOSSARY_STORAGE_KEY]: {
      version: 1,
      terms: sanitizeGlossaryTerms(terms)
    }
  });
}

export async function getGlossaryTerms(): Promise<GlossaryTerm[]> {
  return (await readGlossaryState()).terms;
}

export async function upsertGlossaryTerm(
  input: GlossaryTermInput,
  now = Date.now()
): Promise<GlossaryTerm> {
  const sourceText = normalizeWhitespace(input.sourceText);
  const targetText = normalizeGlossaryTarget(input.targetText);

  if (!sourceText || !/[A-Za-z]/.test(sourceText)) {
    throw new Error("英文术语不能为空，且需要包含英文字母。");
  }

  if (!targetText) {
    throw new Error("中文译法不能为空。");
  }

  const state = await readGlossaryState();
  const sourceKey = normalizeGlossarySource(sourceText);
  const existingIndex = state.terms.findIndex(
    (term) => normalizeGlossarySource(term.sourceText) === sourceKey
  );
  let nextTerm: GlossaryTerm;
  let nextTerms: GlossaryTerm[];

  if (existingIndex >= 0) {
    nextTerm = {
      ...state.terms[existingIndex],
      sourceText,
      targetText,
      enabled: true,
      updatedAt: now
    };
    nextTerms = [...state.terms];
    nextTerms[existingIndex] = nextTerm;
  } else {
    if (state.terms.length >= GLOSSARY_MAX_TERMS) {
      throw new Error(`术语库最多保存 ${GLOSSARY_MAX_TERMS} 条，请先删除旧词条。`);
    }

    nextTerm = {
      id: createGlossaryTermId(),
      sourceText,
      targetText,
      enabled: true,
      createdAt: now,
      updatedAt: now
    };
    nextTerms = [nextTerm, ...state.terms];
  }

  await writeGlossaryTerms(nextTerms);
  return nextTerm;
}

export async function updateGlossaryTerm(
  id: string,
  input: GlossaryTermInput,
  now = Date.now()
): Promise<GlossaryTerm | null> {
  const sourceText = normalizeWhitespace(input.sourceText);
  const targetText = normalizeGlossaryTarget(input.targetText);

  if (!sourceText || !/[A-Za-z]/.test(sourceText)) {
    throw new Error("英文术语不能为空，且需要包含英文字母。");
  }

  if (!targetText) {
    throw new Error("中文译法不能为空。");
  }

  const state = await readGlossaryState();
  const existingIndex = state.terms.findIndex((term) => term.id === id);

  if (existingIndex < 0) {
    return null;
  }

  const sourceKey = normalizeGlossarySource(sourceText);
  const duplicateTerm = state.terms.find(
    (term, index) =>
      index !== existingIndex &&
      normalizeGlossarySource(term.sourceText) === sourceKey
  );

  if (duplicateTerm) {
    throw new Error("该英文术语已存在，请编辑已有词条。");
  }

  const nextTerm = {
    ...state.terms[existingIndex],
    sourceText,
    targetText,
    updatedAt: now
  };
  const nextTerms = [...state.terms];
  nextTerms[existingIndex] = nextTerm;
  await writeGlossaryTerms(nextTerms);
  return nextTerm;
}

export async function deleteGlossaryTerm(id: string): Promise<void> {
  const terms = await getGlossaryTerms();
  await writeGlossaryTerms(terms.filter((term) => term.id !== id));
}

export async function toggleGlossaryTerm(
  id: string,
  enabled: boolean,
  now = Date.now()
): Promise<GlossaryTerm | null> {
  const terms = await getGlossaryTerms();
  const index = terms.findIndex((term) => term.id === id);

  if (index < 0) {
    return null;
  }

  const updatedTerm = {
    ...terms[index],
    enabled,
    updatedAt: now
  };
  const nextTerms = [...terms];
  nextTerms[index] = updatedTerm;
  await writeGlossaryTerms(nextTerms);
  return updatedTerm;
}

export function doesGlossaryTermMatchText(sourceText: string, text: string): boolean {
  const needle = normalizeGlossarySource(sourceText);
  const haystack = normalizeGlossarySource(text);

  if (!needle || !haystack) {
    return false;
  }

  let searchFrom = 0;

  while (searchFrom < haystack.length) {
    const index = haystack.indexOf(needle, searchFrom);

    if (index < 0) {
      return false;
    }

    const before = index > 0 ? haystack[index - 1] : "";
    const afterIndex = index + needle.length;
    const after = afterIndex < haystack.length ? haystack[afterIndex] : "";
    const startsWithWord = isAsciiWordCharacter(needle[0] ?? "");
    const endsWithWord = isAsciiWordCharacter(needle[needle.length - 1] ?? "");
    const hasLeftBoundary = !startsWithWord || !before || !isAsciiWordCharacter(before);
    const hasRightBoundary = !endsWithWord || !after || !isAsciiWordCharacter(after);

    if (hasLeftBoundary && hasRightBoundary) {
      return true;
    }

    searchFrom = index + needle.length;
  }

  return false;
}

export function getMatchedGlossaryTerms(
  texts: string[],
  terms: GlossaryTerm[],
  limit = GLOSSARY_REQUEST_TERM_LIMIT
): GlossaryTerm[] {
  const enabledTerms = terms.filter(
    (term) =>
      term.enabled &&
      term.sourceText.trim() &&
      term.targetText.trim() &&
      /[A-Za-z]/.test(term.sourceText)
  );

  return enabledTerms
    .filter((term) =>
      texts.some((text) => doesGlossaryTermMatchText(term.sourceText, text))
    )
    .sort((left, right) => {
      const lengthDiff =
        normalizeGlossarySource(right.sourceText).length -
        normalizeGlossarySource(left.sourceText).length;

      if (lengthDiff !== 0) {
        return lengthDiff;
      }

      return right.updatedAt - left.updatedAt;
    })
    .slice(0, limit);
}

export function createGlossaryFingerprint(
  text: string,
  terms: GlossaryTerm[] = []
): string {
  const matchedTerms = getMatchedGlossaryTerms([text], terms);

  if (matchedTerms.length === 0) {
    return "";
  }

  return matchedTerms
    .map(
      (term) =>
        `${normalizeGlossarySource(term.sourceText)}=${normalizeGlossaryTarget(
          term.targetText
        )}`
    )
    .sort()
    .join("\u241E");
}
