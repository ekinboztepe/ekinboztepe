// Daily refresh for the profile README (run by .github/workflows/live.yml, or locally:
//   GH_TOKEN=$(gh auth token) node tools/live.mjs).
// 1. Reads each brand's last push and writes sigils/live.json: quiet projects get dimmer sigils.
// 2. Draws the past year of contributions as an LED panel: sigils/out/contributions.svg.
// 3. Rewrites the now:* and calendar:* marker blocks in README.md.
// 4. Re-runs the asset build (without browser cards) so the shelf picks up the new brightness.
// Without access to a private repo its sigil simply stays fully lit.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "sigils", "sigils.json"), "utf8"));
const OWNER = cfg.owner, TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const TILE_BG = "#0e1117";
const DAY = 86400e3, now = Date.now();

async function gh(url, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "sigil-shelf", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) return null;
  return res.json();
}

// 1. Last push per brand -> brightness. Full for two weeks, then a gentle fade to 0.55 over a year:
//    a quiet project should look resting, not dead.
const brightness = {}, pushed = {};
for (const b of cfg.brands) {
  const times = [];
  // Latest real commit: sigil and README-only touch-ups do not count as work.
  for (const repo of b.repos) {
    const commits = await gh(`https://api.github.com/repos/${OWNER}/${repo}/commits?per_page=20`);
    const real = Array.isArray(commits) && commits.find(c => !/\b(sigil|readme)\b/i.test(c.commit.message));
    if (real) times.push(Date.parse(real.commit.committer.date));
  }
  if (!times.length) continue;
  pushed[b.id] = Math.max(...times);
  const days = (now - pushed[b.id]) / DAY;
  brightness[b.id] = +Math.max(0.55, Math.min(1, 1 - (days - 14) / (365 - 14) * 0.45)).toFixed(2);
}
fs.writeFileSync(path.join(ROOT, "sigils", "live.json"), JSON.stringify({ brightness }, null, 2) + "\n");

// 2. Contribution calendar as an LED panel (one pixel per day, five brightness levels).
let calendarNote = "";
const cal = TOKEN && await gh("https://api.github.com/graphql", { query: `{ user(login: "${OWNER}") { contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { contributionCount weekday } } } } } }` });
const weeks = cal?.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
if (weeks) {
  const total = cal.data.user.contributionsCollection.contributionCalendar.totalContributions;
  const counts = weeks.flatMap(w => w.contributionDays.map(d => d.contributionCount)).filter(c => c > 0).sort((a, b) => a - b);
  const q = p => counts[Math.floor(p * (counts.length - 1))] ?? 1;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = c => c === 0 ? 0 : c <= cuts[0] ? 1 : c <= cuts[1] ? 2 : c <= cuts[2] ? 3 : 4;
  const shade = ["#1a1f29", "#3b4250", "#6b7383", "#a9b0bd", "#eef1f5"];
  const U = 12, G = 2, W = weeks.length * U + U, H = 7 * U + U;
  let cells = "";
  weeks.forEach((w, x) => w.contributionDays.forEach(d => {
    cells += `<rect x="${U / 2 + x * U + G / 2}" y="${U / 2 + d.weekday * U + G / 2}" width="${U - G}" height="${U - G}" fill="${shade[level(d.contributionCount)]}"/>`;
  }));
  fs.writeFileSync(path.join(ROOT, "sigils", "out", "contributions.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" shape-rendering="crispEdges" role="img"><title>${total} contributions in the last year</title><rect width="${W}" height="${H}" fill="${TILE_BG}"/>${cells}</svg>\n`);
  calendarNote = `<img src="sigils/out/contributions.svg" width="100%" alt="${total} contributions in the last year, drawn as an LED panel">\n\n<sub>${total} contributions in the last year. One LED per day.</sub>`;
}

// 3. "Now building" line + calendar, between the README markers.
const ago = t => { const d = Math.floor((now - t) / DAY); return d < 1 ? "today" : d < 2 ? "yesterday" : d < 7 ? `${d} days ago` : d < 14 ? "last week" : d < 60 ? `${Math.round(d / 7)} weeks ago` : `${Math.round(d / 30)} months ago`; };
const latest = Object.entries(pushed).sort((a, b) => b[1] - a[1])[0];
let block = "";
if (latest) {
  const [id, t] = latest;
  block += `<img src="sigils/out/${id}/sigil-40.png" width="20" align="absmiddle" alt=""> &nbsp;**Now building:** ${id}, last push ${ago(t)}.\n\n`;
}
const readmePath = path.join(ROOT, "README.md");
const readme = fs.readFileSync(readmePath, "utf8");
const next = readme
  .replace(/<!-- now:start -->[\s\S]*?<!-- now:end -->/, `<!-- now:start -->\n${block.trim()}\n<!-- now:end -->`)
  .replace(/<!-- calendar:start -->[\s\S]*?<!-- calendar:end -->/, `<!-- calendar:start -->\n${calendarNote}\n<!-- calendar:end -->`);
fs.writeFileSync(readmePath, next);

// 4. Rebuild shelf tiles with the new brightness.
execFileSync(process.execPath, [path.join(ROOT, "tools", "build-sigils.mjs"), "--no-cards"], { stdio: "inherit" });
console.log("brightness", brightness, "latest", latest?.[0]);
