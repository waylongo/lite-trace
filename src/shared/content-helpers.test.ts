import {
  calculateEnglishRatio,
  collectTranslatableBlocks,
  groupTranslatableBlocks,
  isEditableNode,
  isTranslatableEnglishText,
  normalizeText
} from "./content-helpers";

describe("content helpers", () => {
  it("normalizes whitespace and detects english-heavy content", () => {
    expect(normalizeText("Hello   world \n from   LiteTrace")).toBe(
      "Hello world from LiteTrace"
    );
    expect(calculateEnglishRatio("Hello world 你好")).toBeGreaterThan(0.5);
    expect(isTranslatableEnglishText("This is an English paragraph prepared for translation.")).toBe(true);
    expect(isTranslatableEnglishText("你好，世界")).toBe(false);
  });

  it("collects visible paragraph-like elements and skips code content", () => {
    document.body.innerHTML = `
      <main>
        <p id="keep">This article explains how browser extensions work in practice.</p>
        <pre><code>This code block should not be translated.</code></pre>
        <p id="skip" style="display:none">Invisible English text.</p>
      </main>
    `;

    const blocks = collectTranslatableBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.element.id).toBe("keep");
  });

  it("detects editable areas", () => {
    document.body.innerHTML = `
      <div>
        <div contenteditable="true"><span id="editable">Editable text</span></div>
        <p><span id="plain">Plain text</span></p>
      </div>
    `;

    expect(isEditableNode(document.getElementById("editable"))).toBe(true);
    expect(isEditableNode(document.getElementById("plain"))).toBe(false);
  });

  it("groups duplicate translatable blocks by normalized text", () => {
    document.body.innerHTML = `
      <main>
        <p>This paragraph is repeated on the page for testing.</p>
        <p>This paragraph is repeated on the page for testing.</p>
        <p>Another paragraph that should stay unique for batching.</p>
      </main>
    `;

    const groups = groupTranslatableBlocks(collectTranslatableBlocks(document));
    expect(groups).toHaveLength(2);
    expect(groups[0]?.blockIndexes).toEqual([0, 1]);
    expect(groups[1]?.blockIndexes).toEqual([2]);
  });
});
