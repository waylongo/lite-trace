import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(projectRoot, relativePath), "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function stripLeadingComments(code) {
  let remaining = code.trimStart();

  while (remaining.startsWith("/*") || remaining.startsWith("//")) {
    if (remaining.startsWith("/*")) {
      const commentEnd = remaining.indexOf("*/");
      remaining =
        commentEnd >= 0 ? remaining.slice(commentEnd + 2).trimStart() : "";
      continue;
    }

    const lineEnd = remaining.indexOf("\n");
    remaining = lineEnd >= 0 ? remaining.slice(lineEnd + 1).trimStart() : "";
  }

  return remaining;
}

function verifyContentScriptBundle() {
  const contentPath = resolve(projectRoot, "dist/content.js");
  assert(existsSync(contentPath), "缺少 dist/content.js，请先执行 npm run build。");

  const contentCode = stripLeadingComments(readFileSync(contentPath, "utf8"));

  assert(
    !/^(?:import|export)\b/.test(contentCode),
    "dist/content.js 仍包含顶层 import/export，Chrome content script 会报 Cannot use import statement outside a module。"
  );
}

function verifyVersions() {
  const packageJson = readJson("package.json");
  const manifestJson = readJson("public/manifest.json");

  assert(
    packageJson.version === manifestJson.version,
    `版本号不一致：package.json=${packageJson.version}，manifest.json=${manifestJson.version}`
  );
}

function verifyBuildArtifacts() {
  [
    "dist/background.js",
    "dist/content.js",
    "dist/popup.html",
    "dist/options.html"
  ].forEach((relativePath) => {
    assert(
      existsSync(resolve(projectRoot, relativePath)),
      `缺少构建产物：${relativePath}`
    );
  });
}

function verifyManifestContentScript() {
  const manifestJson = readJson("public/manifest.json");
  const contentScripts = Array.isArray(manifestJson.content_scripts)
    ? manifestJson.content_scripts
    : [];
  const hasContentScript = contentScripts.some(
    (entry) => Array.isArray(entry.js) && entry.js.includes("content.js")
  );

  assert(hasContentScript, "manifest 没有声明 content.js 作为 content script。");
}

try {
  verifyVersions();
  verifyBuildArtifacts();
  verifyManifestContentScript();
  verifyContentScriptBundle();
  console.log("release artifacts check passed");
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "release artifacts check failed"
  );
  process.exit(1);
}
