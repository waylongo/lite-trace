import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const root = resolve(new URL("../..", import.meta.url).pathname);
const tmpDir = "/private/tmp/litetrace-screenshots";

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function readPng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(data);
    }
  }

  return {
    width,
    height,
    rows: inflateSync(Buffer.concat(idat))
  };
}

function writePng({ width, height, rows }, outputPath) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  writeFileSync(
    outputPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND")
    ])
  );
}

function cropTop(inputPath, outputPath, targetWidth, targetHeight) {
  const png = readPng(readFileSync(inputPath));
  const sourceRowBytes = png.width * 4 + 1;
  const targetRowBytes = targetWidth * 4 + 1;
  const rows = Buffer.alloc(targetRowBytes * targetHeight);

  for (let y = 0; y < targetHeight; y += 1) {
    rows[y * targetRowBytes] = png.rows[y * sourceRowBytes];
    png.rows.copy(
      rows,
      y * targetRowBytes + 1,
      y * sourceRowBytes + 1,
      y * sourceRowBytes + 1 + targetWidth * 4
    );
  }

  writePng(
    {
      width: targetWidth,
      height: targetHeight,
      rows
    },
    outputPath
  );
}

function page(title, subtitle, body) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      * { box-sizing: border-box; }
      body {
        width: 1280px;
        height: 800px;
        margin: 0;
        overflow: hidden;
        color: #17231e;
        background: linear-gradient(180deg, #fbfaf7 0%, #f2f5ef 100%);
        font-family: "Avenir Next", "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .frame { padding: 44px 58px; }
      .brand { color: #0a6f51; font-size: 18px; font-weight: 900; letter-spacing: 0.12em; }
      h1 { margin: 14px 0 8px; font-size: 54px; line-height: 1.04; letter-spacing: 0; }
      .sub { margin: 0 0 28px; color: #5f7169; font-size: 23px; line-height: 1.45; }
      .stage {
        position: relative;
        height: 570px;
        border: 1px solid #dfe6dd;
        border-radius: 24px;
        background: rgba(255,255,255,.92);
        box-shadow: 0 22px 56px rgba(29,44,36,.10);
        overflow: hidden;
      }
      .article { padding: 42px 54px; font-family: Georgia, "Times New Roman", serif; font-size: 27px; line-height: 1.55; }
      .translation { color: #214f42; font-family: "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 24px; }
      .bubble {
        position: absolute; right: 28px; top: 210px; width: 54px; height: 54px; border-radius: 999px;
        display: grid; place-items: center; color: #f8fff9; background: #203127;
        box-shadow: 0 16px 36px rgba(9,49,37,.25); font-size: 28px; font-weight: 900;
      }
      .card {
        position: absolute; right: 58px; top: 74px; width: 430px; padding: 28px;
        border: 1px solid #d9e4dc; border-radius: 22px; background: #fff;
        box-shadow: 0 20px 44px rgba(29,44,36,.14);
      }
      .card h2 { margin: 0 0 14px; font-size: 28px; }
      .field { margin-top: 14px; padding: 14px 16px; border: 1px solid #d7e1d9; border-radius: 14px; background: #f8faf7; font-size: 20px; }
      .button { display: inline-block; margin-top: 18px; padding: 12px 18px; border-radius: 999px; color: white; background: linear-gradient(135deg,#0a6f51,#2767a7); font-size: 18px; font-weight: 800; }
      .settings { padding: 36px 44px; }
      .term { display: grid; grid-template-columns: 40px 1fr 1fr auto; gap: 12px; align-items: center; margin-top: 12px; padding: 14px; border: 1px solid #dfe6dd; border-radius: 16px; background: #f8faf7; font-size: 20px; }
      .tag { color: #0a6f51; font-weight: 900; }
      mark { border-radius: 5px; background: #e2f1ea; color: inherit; }
      ${body.css ?? ""}
    </style>
  </head>
  <body>
    <div class="frame">
      <div class="brand">LITETRACE</div>
      <h1>${title}</h1>
      <p class="sub">${subtitle}</p>
      <div class="stage">${body.html}</div>
    </div>
  </body>
</html>`;
}

function promoPage() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      * { box-sizing: border-box; }
      body {
        width: 1280px;
        height: 800px;
        margin: 0;
        overflow: hidden;
        background: #fbfaf7;
        font-family: "Avenir Next", "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .tile {
        position: relative;
        width: 352px;
        height: 224px;
        color: #17231e;
        background: linear-gradient(145deg, #fbfaf7 0%, #eef5f0 100%);
      }
      .wrap {
        position: relative;
        width: 100%;
        height: 100%;
        padding: 23px 24px;
      }
      .brand {
        color: #0a6f51;
        font-size: 13px;
        font-weight: 900;
        letter-spacing: .13em;
      }
      h1 {
        margin: 13px 0 8px;
        max-width: 212px;
        font-size: 31px;
        line-height: 1.05;
        letter-spacing: 0;
      }
      .sub {
        margin: 0;
        max-width: 204px;
        color: #586c64;
        font-size: 13px;
        line-height: 1.42;
        font-weight: 700;
      }
      .chips {
        position: absolute;
        left: 24px;
        bottom: 22px;
        display: flex;
        gap: 7px;
      }
      .chip {
        padding: 6px 8px;
        border: 1px solid #cfe0d6;
        border-radius: 999px;
        background: rgba(255,255,255,.76);
        color: #0d614a;
        font-size: 11px;
        font-weight: 900;
      }
      .panel {
        position: absolute;
        left: 222px;
        top: 49px;
        width: 108px;
        padding: 12px;
        border: 1px solid #d9e4dc;
        border-radius: 15px;
        background: rgba(255,255,255,.96);
        box-shadow: 0 18px 40px rgba(29,44,36,.13);
      }
      .line {
        height: 7px;
        margin-bottom: 8px;
        border-radius: 999px;
        background: #dfe8e2;
      }
      .line.short { width: 70%; }
      .translation {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid #edf2ee;
      }
      .translation .line { background: #c9e4d8; }
      .bubble {
        position: absolute;
        right: 16px;
        bottom: 16px;
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        border-radius: 999px;
        color: #f8fff9;
        background: #203127;
        box-shadow: 0 16px 34px rgba(9,49,37,.25);
        font-size: 17px;
        font-weight: 900;
      }
    </style>
  </head>
  <body>
    <div class="tile">
      <div class="wrap">
        <div class="brand">LITETRACE</div>
        <h1>LLM API<br />术语记忆</h1>
        <p class="sub">接入自己的大模型，让技术概念译法保持一致。</p>
        <div class="chips"><span class="chip">双语阅读</span><span class="chip">本地术语库</span></div>
        <div class="panel">
          <div class="line"></div>
          <div class="line short"></div>
          <div class="translation">
            <div class="line"></div>
            <div class="line short"></div>
          </div>
        </div>
        <div class="bubble">✓</div>
      </div>
    </div>
  </body>
</html>`;
}

const pages = [
  [
    "双语长文顺着读",
    "原文和中文对照留在页面里，右侧 bubble 显示当前阅读状态。",
    {
      name: "1-cws",
      html: `<div class="article">
        <p>React Server Components let teams move data fetching closer to the server.</p>
        <p class="translation">React 服务器组件让团队把数据获取放到更靠近服务器的位置。</p>
        <p>The <mark>API</mark> boundary becomes easier to reason about across documentation.</p>
        <p class="translation"><mark>接口</mark> 边界会在文档中更容易理解。</p>
      </div><div class="bubble">✓</div>`
    }
  ],
  [
    "划词即时查看",
    "选中术语或句子，页面内 icon 入口直接返回中文结果。",
    {
      name: "2-cws",
      html: `<div class="article">
        <p>Teams often discuss <mark>React Server Components</mark> when they want smaller client bundles.</p>
      </div>
      <div class="card"><h2>划词翻译</h2><p class="translation">React 服务器组件</p><span class="button">复制译文</span></div>`
    }
  ],
  [
    "右键加入术语",
    "把 API、框架名和产品概念固定成你习惯的译法。",
    {
      name: "3-cws",
      html: `<div class="article"><p>The <mark>API</mark> boundary should stay consistent in docs and UI text.</p></div>
      <div class="card"><h2>加入浅译术语</h2><div class="field">英文术语：API</div><div class="field">中文译法：接口</div><span class="button">保存术语</span></div>`
    }
  ],
  [
    "本地管理术语库",
    "搜索、编辑、启用或停用术语，偏好只保存在本地浏览器。",
    {
      name: "4-cws",
      html: `<div class="settings">
        <div class="term"><span class="tag">✓</span><span>API</span><span>接口</span><span class="tag">启用</span></div>
        <div class="term"><span class="tag">✓</span><span>React Server Components</span><span>React 服务器组件</span><span class="tag">启用</span></div>
        <div class="term"><span>○</span><span>hydration</span><span>水合</span><span>停用</span></div>
      </div>`
    }
  ]
];

mkdirSync(tmpDir, { recursive: true });

for (const [title, subtitle, body] of pages) {
  const htmlPath = resolve(tmpDir, `${body.name}.html`);
  writeFileSync(htmlPath, page(title, subtitle, body), "utf8");
  if (!process.env.LITETRACE_SKIP_QUICKLOOK) {
    execFileSync("qlmanage", ["-t", "-s", "1280", "-o", tmpDir, htmlPath], {
      stdio: "inherit"
    });
  }

  if (process.env.LITETRACE_WRITE_ONLY) {
    continue;
  }
  const thumbnailPath = resolve(tmpDir, `${basename(htmlPath)}.png`);
  if (!existsSync(thumbnailPath)) {
    throw new Error(`Missing Quick Look thumbnail for ${htmlPath}`);
  }
  cropTop(thumbnailPath, resolve(root, `screenshots/cws/${body.name}.png`), 1280, 800);
}

const promoHtmlPath = resolve(tmpDir, "promo-440x280.html");
writeFileSync(promoHtmlPath, promoPage(), "utf8");
if (!process.env.LITETRACE_SKIP_QUICKLOOK) {
  execFileSync("qlmanage", ["-t", "-s", "1280", "-o", tmpDir, promoHtmlPath], {
    stdio: "inherit"
  });
}

if (process.env.LITETRACE_WRITE_ONLY) {
  console.log("LiteTrace screenshot HTML files generated.");
  process.exit(0);
}

cropTop(
  resolve(tmpDir, "promo-440x280.html.png"),
  resolve(root, "screenshots/cws/promo-440x280.png"),
  440,
  280
);

[
  ["1.png", "1-cws.png"],
  ["2.png", "2-cws.png"],
  ["3.png", "3-cws.png"],
  ["4.png", "4-cws.png"]
].forEach(([target, source]) => {
  writeFileSync(
    resolve(root, `screenshots/${target}`),
    readFileSync(resolve(root, `screenshots/cws/${source}`))
  );
});

console.log("LiteTrace screenshots generated.");
