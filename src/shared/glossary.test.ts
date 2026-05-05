import {
  createGlossaryFingerprint,
  doesGlossaryTermMatchText,
  getGlossaryTerms,
  getMatchedGlossaryTerms,
  GLOSSARY_MAX_TERMS,
  GLOSSARY_REQUEST_TERM_LIMIT,
  GLOSSARY_STORAGE_KEY,
  toggleGlossaryTerm,
  updateGlossaryTerm,
  upsertGlossaryTerm
} from "./glossary";
import type { GlossaryTerm } from "./types";

function createTerm(
  sourceText: string,
  targetText: string,
  overrides: Partial<GlossaryTerm> = {}
): GlossaryTerm {
  return {
    id: `${sourceText}-${targetText}`,
    sourceText,
    targetText,
    enabled: true,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  };
}

describe("glossary helpers", () => {
  let storageStore: Record<string, unknown>;

  beforeEach(() => {
    storageStore = {};

    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) =>
            key in storageStore ? { [key]: storageStore[key] } : {}
          ),
          set: vi.fn(async (items: Record<string, unknown>) => {
            storageStore = {
              ...storageStore,
              ...items
            };
          })
        }
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cleans stored terms and updates duplicates by normalized source", async () => {
    const first = await upsertGlossaryTerm(
      {
        sourceText: "  React   Server Components ",
        targetText: " React 服务器组件 "
      },
      1_000
    );
    const second = await upsertGlossaryTerm(
      {
        sourceText: "react server components",
        targetText: "RSC"
      },
      2_000
    );

    await expect(getGlossaryTerms()).resolves.toEqual([
      {
        ...first,
        sourceText: "react server components",
        targetText: "RSC",
        updatedAt: 2_000
      }
    ]);
    expect(second.id).toBe(first.id);
  });

  it("enforces the global term limit for new entries", async () => {
    storageStore[GLOSSARY_STORAGE_KEY] = {
      version: 1,
      terms: Array.from({ length: GLOSSARY_MAX_TERMS }, (_, index) =>
        createTerm(`Term ${index}`, `术语 ${index}`)
      )
    };

    await expect(
      upsertGlossaryTerm({
        sourceText: "Another term",
        targetText: "另一个术语"
      })
    ).rejects.toThrow(`术语库最多保存 ${GLOSSARY_MAX_TERMS} 条`);
  });

  it("toggles terms without deleting them", async () => {
    const term = await upsertGlossaryTerm({
      sourceText: "vector database",
      targetText: "向量数据库"
    });

    await toggleGlossaryTerm(term.id, false, 3_000);

    await expect(getGlossaryTerms()).resolves.toMatchObject([
      {
        id: term.id,
        enabled: false,
        updatedAt: 3_000
      }
    ]);
  });

  it("updates a term by id while preserving enabled state", async () => {
    const term = await upsertGlossaryTerm({
      sourceText: "vector database",
      targetText: "向量数据库"
    });
    await toggleGlossaryTerm(term.id, false, 2_000);

    await updateGlossaryTerm(
      term.id,
      {
        sourceText: "embedding index",
        targetText: "嵌入索引"
      },
      3_000
    );

    await expect(getGlossaryTerms()).resolves.toMatchObject([
      {
        id: term.id,
        sourceText: "embedding index",
        targetText: "嵌入索引",
        enabled: false,
        updatedAt: 3_000
      }
    ]);
  });

  it("rejects updating a term to another existing source", async () => {
    const first = await upsertGlossaryTerm({
      sourceText: "API",
      targetText: "接口"
    });
    await upsertGlossaryTerm({
      sourceText: "SDK",
      targetText: "开发套件"
    });

    await expect(
      updateGlossaryTerm(first.id, {
        sourceText: "SDK",
        targetText: "软件开发工具包"
      })
    ).rejects.toThrow("该英文术语已存在");
  });

  it("matches english phrases case-insensitively with word boundaries", () => {
    expect(doesGlossaryTermMatchText("API", "This API stays stable.")).toBe(true);
    expect(doesGlossaryTermMatchText("API", "The apiculture note is unrelated.")).toBe(
      false
    );
    expect(
      doesGlossaryTermMatchText(
        "React Server Components",
        "react server components change rendering boundaries."
      )
    ).toBe(true);
  });

  it("returns matched terms by longer phrase and recent update priority", () => {
    const terms = [
      createTerm("API", "接口", { updatedAt: 5_000 }),
      createTerm("React Server Components", "React 服务器组件", {
        updatedAt: 2_000
      }),
      createTerm("React", "React", { updatedAt: 9_000 }),
      createTerm("disabled term", "停用术语", { enabled: false })
    ];

    expect(
      getMatchedGlossaryTerms(
        ["React Server Components rely on the API."],
        terms
      ).map((term) => term.sourceText)
    ).toEqual(["React Server Components", "React", "API"]);
  });

  it("limits request glossary terms to fifty entries", () => {
    const terms = Array.from({ length: GLOSSARY_REQUEST_TERM_LIMIT + 5 }, (_, index) =>
      createTerm(`Term ${index}`, `术语 ${index}`, {
        updatedAt: index
      })
    );
    const text = terms.map((term) => term.sourceText).join(" ");

    expect(getMatchedGlossaryTerms([text], terms)).toHaveLength(
      GLOSSARY_REQUEST_TERM_LIMIT
    );
  });

  it("creates fingerprints from enabled matched terms only", () => {
    const terms = [
      createTerm("API", "接口"),
      createTerm("cache", "缓存", { enabled: false })
    ];

    expect(createGlossaryFingerprint("The API cache is warm.", terms)).toContain(
      "api=接口"
    );
    expect(createGlossaryFingerprint("The cache is warm.", terms)).toBe("");
  });
});
