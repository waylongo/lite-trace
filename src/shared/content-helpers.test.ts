import {
  calculateEnglishRatio,
  collectTranslatableBlocks,
  groupTranslatableBlocks,
  isEditableNode,
  isTranslatableBlockText,
  isTranslatableEnglishText,
  isTranslatableSelectionText,
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

  it("accepts short english selections without loosening page-level rules", () => {
    expect(isTranslatableSelectionText("hello")).toBe(true);
    expect(isTranslatableSelectionText("privacy policy")).toBe(true);
    expect(isTranslatableSelectionText("This is short.")).toBe(true);
    expect(isTranslatableSelectionText("你好")).toBe(false);
    expect(isTranslatableSelectionText("12345")).toBe(false);
    expect(isTranslatableSelectionText("!!!")).toBe(false);
    expect(isTranslatableSelectionText("a".repeat(601))).toBe(false);
    expect(isTranslatableEnglishText("privacy policy")).toBe(false);
  });

  it("allows shorter english headings while keeping paragraph thresholds unchanged", () => {
    const heading = document.createElement("h2");
    const paragraph = document.createElement("p");

    expect(isTranslatableBlockText(heading, "Market outlook")).toBe(true);
    expect(isTranslatableBlockText(paragraph, "Market outlook")).toBe(false);
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

  it("falls back to body scanning when no preferred root exists", () => {
    document.body.innerHTML = `
      <section>
        <p id="keep">This fallback paragraph should still be discovered from the body root.</p>
      </section>
    `;

    const blocks = collectTranslatableBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.element.id).toBe("keep");
  });

  it("prefers preferred roots over unrelated body content", () => {
    document.body.innerHTML = `
      <div role="main">
        <p id="keep">This paragraph belongs to the primary reading area and should be discovered.</p>
      </div>
      <section>
        <p id="skip">This unrelated body paragraph should not be scanned once a preferred root exists.</p>
      </section>
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

  it("scans nested preferred roots without duplicating their contents", () => {
    document.body.innerHTML = `
      <main>
        <p id="intro">This introduction stays directly under main and should be translated once.</p>
        <article>
          <p id="article-copy">This article paragraph should be translated once as well.</p>
        </article>
      </main>
    `;

    const blocks = collectTranslatableBlocks(document);
    expect(blocks.map((block) => block.element.id)).toEqual(["intro", "article-copy"]);
  });

  it("skips container blocks when nested target blocks already carry the content", () => {
    document.body.innerHTML = `
      <main>
        <ul>
          <li id="container">
            <p id="leaf">This list item should only be translated once, not at both the list item and paragraph levels.</p>
          </li>
        </ul>
      </main>
    `;

    const blocks = collectTranslatableBlocks(document);
    expect(blocks.map((block) => block.element.id)).toEqual(["leaf"]);
  });

  it("includes article titles inside article headers", () => {
    document.body.innerHTML = `
      <article>
        <header>
          <h1 id="title">Market outlook</h1>
        </header>
        <p id="body">This article explains what might happen next in the market.</p>
      </article>
    `;

    const blocks = collectTranslatableBlocks(document);
    expect(blocks.map((block) => block.element.id)).toEqual(["title", "body"]);
  });
});
