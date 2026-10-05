import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Astro's locked image pipeline supplies sharp. Assets are derived from the
// existing Vectory mark, original artwork, and an authentic demo screenshot.
const require = createRequire(path.join(repoRoot, "help-center/package.json"));
const sharp = require("sharp");

export async function buildBrandAssets(output) {
  const iconRoot = path.join(output, "favicons");
  await fs.mkdir(iconRoot, { recursive: true });
  const mark = await fs.readFile(path.join(repoRoot, "dashboard/public/favicon.svg"));
  const sizes = [16, 32, 180, 192, 512];
  for (const size of sizes) {
    await sharp(mark).resize(size, size).png().toFile(path.join(iconRoot, `icon-${size}.png`));
  }
  const frames = await Promise.all([16, 32].map(size => fs.readFile(path.join(iconRoot, `icon-${size}.png`))));
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    const size = [16, 32][index];
    header[entry] = size;
    header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  await fs.writeFile(path.join(output, "favicon.ico"), Buffer.concat([header, ...frames]));
  await fs.writeFile(path.join(output, "site.webmanifest"), JSON.stringify({
    name: "Vectory tools and guides", short_name: "Vectory", start_url: "/designer/",
    display: "browser", background_color: "#f3f1eb", theme_color: "#f3f1eb",
    icons: [192, 512].map(size => ({src: `/favicons/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png", purpose: "any"})),
  }, null, 2));

  const background = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <rect width="1200" height="630" fill="#f3f1eb"/>
    <path d="M0 118H1200 M620 0V630" stroke="#d4d3ce"/>
    <g font-family="Arial, Helvetica, sans-serif">
      <text x="102" y="68" font-size="30" font-weight="700" fill="#202122">Vectory</text>
      <text x="1140" y="66" text-anchor="end" font-size="18" fill="#5b5d61">OPEN SOURCE / SELF-HOSTED</text>
      <text x="48" y="234" font-size="73" font-weight="700" letter-spacing="-4" fill="#202122">Vector pipelines.</text>
      <text x="48" y="322" font-size="73" font-weight="700" letter-spacing="-4" fill="#4856e5">Your control.</text>
      <text x="52" y="404" font-size="25" fill="#343639">Design the flow.</text>
      <text x="52" y="440" font-size="25" fill="#343639">Know what runs on every host.</text>
      <text x="52" y="575" font-size="20" fill="#4856e5">vectory.ahmadz.ai</text>
      <text x="652" y="231" font-size="14" fill="#5b5d61">ACTUAL EDITOR / DEMO DATA</text>
    </g></svg>`;
  const art = await sharp(path.join(repoRoot, "site/assets/flow-art.webp")).resize(530).png().toBuffer();
  const screenshot = await sharp(path.join(repoRoot, "docs/screenshots/product-editor.png")).resize(500).png().toBuffer();
  const logo = await sharp(mark).resize(36).png().toBuffer();
  await sharp(Buffer.from(background)).composite([
    {input: logo, left: 52, top: 38},
    {input: art, left: 650, top: 352},
    {input: screenshot, left: 652, top: 249},
  ]).png().toFile(path.join(output, "social-preview.png"));
}
