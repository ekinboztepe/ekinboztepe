// Builds every brand asset from sigils/sigils.json.
//   node tools/build-sigils.mjs            -> style from sigils.json ("led")
//   node tools/build-sigils.mjs --style solid
//   node tools/build-sigils.mjs --card a      (social preview layout: a light, b brand-tinted, c poster; default from sigils.json)
//   node tools/build-sigils.mjs --no-cards  (skip the browser-rendered social previews)
// Output: sigils/out/<brand>/{sigil.svg, sigil-<size>.png, social-preview.png, sigil.json}
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "sigils", "sigils.json");
const OUT = path.join(ROOT, "sigils", "out");
const BUILD = path.join(ROOT, "sigils", ".build");
const SIZES = [40, 80, 160, 320, 640];
const TILE_BG = "#0e1117";

const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(SRC, "utf8"));
const style = args.includes("--style") ? args[args.indexOf("--style") + 1] : cfg.style;
if (!["led", "solid"].includes(style)) throw new Error(`unknown style "${style}" (led | solid)`);

// ---------- sigil model ----------
const isOn = (b, r, c) => b.rows[r][c] === "#";
const hexOf = rows => { let v = 0n; for (const ch of rows.join("")) v = (v << 1n) | (ch === "#" ? 1n : 0n); return "0x" + v.toString(16).toUpperCase().padStart(16, "0"); };
const rowBytes = rows => rows.map(r => parseInt(r.replace(/#/g, "1").replace(/\./g, "0"), 2).toString(16).toUpperCase().padStart(2, "0"));
const rgb = h => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const mix = (a, b, t) => a.map((x, i) => Math.round(x * (1 - t) + b[i] * t));

// The tile is 10x10 units: the 8x8 sigil plus one unit of margin.
// Returns the list of filled rects in unit space, shared by the SVG and PNG writers.
function tileRects(b, st, base = TILE_BG) {
  const fg = rgb(b.color), bg = st === "solid" ? fg : rgb(base);
  const rects = [{ x: 0, y: 0, w: 10, h: 10, c: bg, cell: false }];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const on = isOn(b, r, c);
    if (st === "solid") { if (on) rects.push({ x: c + 1, y: r + 1, w: 1, h: 1, c: [255, 255, 255], cell: true }); continue; }
    rects.push({ x: c + 1, y: r + 1, w: 1, h: 1, c: on ? fg : mix(rgb(base), fg, 0.14), cell: true });
  }
  return rects;
}
const gapFor = (st, unitPx) => st === "led" && unitPx >= 4 ? Math.max(1, Math.round(unitPx * 0.14)) / unitPx : 0;
const css = c => `rgb(${c.join(",")})`;

function svgTile(b, st, { px = 320, title = true, base = TILE_BG } = {}) {
  const g = st === "led" ? 0.14 : 0;
  const body = tileRects(b, st, base).map(r => {
    const k = r.cell ? g : 0;
    return `<rect x="${(r.x + k) * 10}" y="${(r.y + k) * 10}" width="${(r.w - 2 * k) * 10}" height="${(r.h - 2 * k) * 10}" fill="${css(r.c)}"/>`;
  }).join("");
  const t = title ? `<title>${b.id} · ${b.hex}</title>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${px}" height="${px}" shape-rendering="crispEdges">${t}${body}</svg>`;
}

// ---------- PNG (no dependencies) ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const x of buf) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngTile(b, st, size) {
  const u = size / 10, g = Math.round(gapFor(st, u) * u);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const put = (x0, y0, x1, y1, c) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * (size * 3 + 1) + 1 + x * 3; raw[i] = c[0]; raw[i + 1] = c[1]; raw[i + 2] = c[2]; } };
  const rects = tileRects(b, st);
  put(0, 0, size, size, rects[0].c);
  for (const r of rects.slice(1)) put(Math.round(r.x * u) + g, Math.round(r.y * u) + g, Math.round((r.x + r.w) * u) - g, Math.round((r.y + r.h) * u) - g, r.c);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- social preview (1280x640, rendered by a local Chromium) ----------
const esc = s => s.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
// Simplified variants: no kicker label, no background echo, no bottom rule.
// a = light "printed panel", b = brand-tinted dark, all monospace text, c = poster with a full-height sigil.
function variantHtml(b, st, repo, v) {
  const bytes = rowBytes(b.rows);
  const line = esc(b.short || b.tagline);
  const fonts = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Silkscreen&family=Archivo:wght@400;500&family=Martian+Mono:wght@400&family=IBM+Plex+Mono:wght@400;500&display=block">`;
  const base = `*{margin:0;box-sizing:border-box}html,body{width:1280px;height:640px;overflow:hidden}body{position:relative}`;
  const col = bytes.map(x => `<span>${x}</span>`).join("");
  if (v === "a") return `<!doctype html><meta charset="utf-8">${fonts}<style>${base}
body{background:#e6e8eb;font-family:Archivo,sans-serif}
.tile{position:absolute;left:96px;top:140px;box-shadow:0 18px 40px rgba(0,0,0,.18)}
.bytes{position:absolute;left:472px;top:176px;display:grid;grid-auto-rows:36px;align-items:center;font:500 20px "IBM Plex Mono",monospace;color:#7a808a}
h1{position:absolute;left:584px;top:190px;font:400 72px/1 Silkscreen,monospace;color:#111418}
p{position:absolute;left:584px;top:300px;width:600px;font-size:34px;line-height:1.3;color:#2b3038}
.foot{position:absolute;left:584px;bottom:136px;font:400 22px "IBM Plex Mono",monospace;color:#7a808a}
</style><div class="tile">${svgTile(b, st, { px: 360, title: false })}</div><div class="bytes">${col}</div>
<h1>${esc(b.id)}</h1><p>${line}</p><div class="foot">ekinboztepe/${esc(repo)}</div>`;
  if (v === "b") { const bgc = mix([0, 0, 0], rgb(b.color), 0.1), bg = css(bgc), bgHex = "#" + bgc.map(x => x.toString(16).padStart(2, "0")).join(""); return `<!doctype html><meta charset="utf-8">${fonts}<style>${base}
body{background:${bg};font-family:"Martian Mono",monospace;color:#d6d6d6}
.tile{position:absolute;left:96px;top:140px}
.bytes{position:absolute;left:472px;top:176px;display:grid;grid-auto-rows:36px;align-items:center;font-size:19px;color:${b.color}}
h1{position:absolute;left:584px;top:186px;font:400 72px/1 Silkscreen,monospace;color:#f4f4f4}
p{position:absolute;left:584px;top:296px;width:600px;font-size:25px;line-height:1.55;color:#bdbdbd}
.foot{position:absolute;left:584px;bottom:136px;font-size:19px;color:${b.color}}
</style><div class="tile">${svgTile(b, st, { px: 360, title: false, base: bgHex })}</div><div class="bytes">${col}</div>
<h1>${esc(b.id)}</h1><p>${line}</p><div class="foot">ekinboztepe/${esc(repo)}</div>`; }
  return `<!doctype html><meta charset="utf-8">${fonts}<style>${base}
body{background:${TILE_BG};font-family:Archivo,sans-serif;color:#f2f2f2}
.tile{position:absolute;left:0;top:0}
h1{position:absolute;left:720px;top:200px;font:400 ${Math.min(80, Math.floor(480 / (b.id.length * 0.8)))}px/1 Silkscreen,monospace}
p{position:absolute;left:720px;top:318px;width:480px;font-size:32px;line-height:1.3;color:#b8b8b8}
.sig{position:absolute;left:720px;bottom:116px;font:400 19px "IBM Plex Mono",monospace;color:#6e7681}
.bytes{position:absolute;left:720px;bottom:72px;font:500 22px "IBM Plex Mono",monospace;letter-spacing:3px;color:${b.color};display:flex;gap:14px}
</style><div class="tile">${svgTile(b, st, { px: 640, title: false })}</div>
<h1>${esc(b.id)}</h1><p>${line}</p><div class="sig">ekinboztepe/${esc(repo)}</div><div class="bytes">${col}</div>`;
}
function findBrowser() {
  const c = [
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
    path.join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return c.find(p => p && fs.existsSync(p));
}
function screenshot(browser, htmlFile, pngFile) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sigil-"));
  try {
    execFileSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--force-device-scale-factor=1",
      `--user-data-dir=${profile}`, "--window-size=1280,640", "--virtual-time-budget=6000", `--screenshot=${pngFile}`, pathToFileURL(htmlFile).href],
      { stdio: "ignore", timeout: 60000 });
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}

// ---------- main ----------
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(BUILD, { recursive: true });

// node tools/build-sigils.mjs --preview-variants cipherforest  -> sigils/.build/variants/<id>-{a,b,c}.png
if (args.includes("--preview-variants")) {
  const id = args[args.indexOf("--preview-variants") + 1];
  const raw = cfg.brands.find(x => x.id === id); if (!raw) throw new Error(`no brand "${id}"`);
  const b = { ...raw, hex: hexOf(raw.rows) }, browser = findBrowser(), vdir = path.join(BUILD, "variants");
  fs.mkdirSync(vdir, { recursive: true });
  for (const v of ["a", "b", "c"]) {
    const html = path.join(vdir, `${id}-${v}.html`);
    fs.writeFileSync(html, variantHtml(b, style, b.repos[0], v));
    screenshot(browser, html, path.join(vdir, `${id}-${v}.png`));
    console.log(path.join(vdir, `${id}-${v}.png`));
  }
  process.exit(0);
}
const card = args.includes("--card") ? args[args.indexOf("--card") + 1] : (cfg.card || "c");
if (!["a", "b", "c"].includes(card)) throw new Error(`unknown card "${card}" (a | b | c)`);
const browser = args.includes("--no-cards") ? null : findBrowser();
if (!args.includes("--no-cards") && !browser) console.warn("No Chromium browser found; skipping social previews.");

for (const raw of cfg.brands) {
  const b = { ...raw, hex: hexOf(raw.rows) };
  const dir = path.join(OUT, b.id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sigil.svg"), svgTile(b, style) + "\n");
  for (const s of SIZES) fs.writeFileSync(path.join(dir, `sigil-${s}.png`), pngTile(b, style, s));
  fs.writeFileSync(path.join(dir, "sigil.json"), JSON.stringify({ name: b.id, hex: b.hex, rows: b.rows, color: b.color, style, tagline: b.tagline }, null, 2) + "\n");
  // One social preview per repo (a brand can span several repos).
  if (browser) for (const repo of b.repos) {
    const name = b.repos.length > 1 ? `social-preview-${repo}` : "social-preview";
    const html = path.join(BUILD, `${repo}.html`);
    fs.writeFileSync(html, variantHtml(b, style, repo, card));
    screenshot(browser, html, path.join(dir, `${name}.png`));
  }
  console.log(`${b.id.padEnd(14)} ${b.hex}  ${style}${browser ? "  + social-preview" : ""}`);
}

// ---------- profile shelf: every sigil side by side, pixels lighting up in bit order ----------
// Pixels default to lit; the animation only starts them dark, so a viewer without
// CSS animation still sees the finished shelf.
function shelfSvg(brands) {
  const T = 100, GAP = 20, W = brands.length * T + (brands.length - 1) * GAP, g = 1.4;
  let body = "", n = 0;
  brands.forEach((b, t) => {
    const x0 = t * (T + GAP), fg = rgb(b.color), dim = css(mix(rgb(TILE_BG), fg, 0.14));
    body += `<rect x="${x0}" y="0" width="${T}" height="${T}" fill="${TILE_BG}"/>`;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const x = x0 + (c + 1) * 10 + g, y = (r + 1) * 10 + g, s = 10 - 2 * g;
      body += `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${dim}"/>`;
      if (isOn(b, r, c)) body += `<rect class="p" style="animation-delay:${(t * 0.22 + n++ * 0.012).toFixed(3)}s" x="${x}" y="${y}" width="${s}" height="${s}" fill="${b.color}"/>`;
    }
  });
  const title = brands.map(b => `${b.id} ${b.hex}`).join(", ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${T}" width="${W}" height="${T}" shape-rendering="crispEdges" role="img"><title>${title}</title>
<style>.p{animation:lit .12s ease-out both}@keyframes lit{from{opacity:0}to{opacity:1}}@media (prefers-reduced-motion:reduce){.p{animation:none}}</style>${body}</svg>\n`;
}
fs.writeFileSync(path.join(OUT, "shelf.svg"), shelfSvg(cfg.brands.map(raw => ({ ...raw, hex: hexOf(raw.rows) }))));
console.log("shelf.svg");
