import {
  calculateEnglishRatio,
  collectTranslatableBlocks,
  groupTranslatableBlocks,
  isEditableNode,
  isTranslatableBlockText,
  isTranslatableEnglishText,
  isTranslatableSelectionText,
  normalizeText,
  prioritizeTranslatableBlocks
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

  it("prioritizes visible blocks, then upcoming blocks, before earlier offscreen blocks", () => {
    document.body.innerHTML = `
      <main>
        <p id="above">This earlier paragraph appears above the current viewport for priority testing.</p>
        <p id="visible">This visible paragraph should be translated before the surrounding content.</p>
        <p id="below">This upcoming paragraph should be translated after visible content.</p>
      </main>
    `;

    const rects: Record<string, DOMRect> = {
      above: new DOMRect(0, -240, 640, 40),
      visible: new DOMRect(0, 120, 640, 40),
      below: new DOMRect(0, 740, 640, 40)
    };

    for (const [id, rect] of Object.entries(rects)) {
      Object.defineProperty(
        document.getElementById(id) as HTMLElement,
        "getBoundingClientRect",
        {
          configurable: true,
          value: () => rect
        }
      );
    }

    const blocks = collectTranslatableBlocks(document);
    expect(blocks.map((block) => block.element.id)).toEqual([
      "above",
      "visible",
      "below"
    ]);
    expect(
      prioritizeTranslatableBlocks(blocks, 600).map((block) => block.element.id)
    ).toEqual(["visible", "below", "above"]);
  });

  it("groups repeated text after viewport priority so the highest-priority duplicate leads", () => {
    document.body.innerHTML = `
      <main>
        <p id="repeat-above">This repeated paragraph should share one translation request in priority order.</p>
        <p id="unique-below">This unique paragraph should stay behind visible repeated content.</p>
        <p id="repeat-visible">This repeated paragraph should share one translation request in priority order.</p>
      </main>
    `;

    const rects: Record<string, DOMRect> = {
      "repeat-above": new DOMRect(0, -240, 640, 40),
      "unique-below": new DOMRect(0, 740, 640, 40),
      "repeat-visible": new DOMRect(0, 120, 640, 40)
    };

    for (const [id, rect] of Object.entries(rects)) {
      Object.defineProperty(
        document.getElementById(id) as HTMLElement,
        "getBoundingClientRect",
        {
          configurable: true,
          value: () => rect
        }
      );
    }

    const prioritizedBlocks = prioritizeTranslatableBlocks(
      collectTranslatableBlocks(document),
      600
    );
    const groups = groupTranslatableBlocks(prioritizedBlocks);

    expect(prioritizedBlocks.map((block) => block.element.id)).toEqual([
      "repeat-visible",
      "unique-below",
      "repeat-above"
    ]);
    expect(groups[0]?.text).toBe(
      "This repeated paragraph should share one translation request in priority order."
    );
    expect(groups[0]?.blockIndexes).toEqual([0, 2]);
  });
});
