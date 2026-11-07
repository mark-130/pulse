// pnpm icons: renders the orb app icon SVGs to the PNG sizes the PWA needs.
// Inputs: apps/web/public/icon.svg and icon-maskable.svg. Outputs are committed.
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const pub = new URL("../apps/web/public/", import.meta.url);
const regular = await readFile(new URL("icon.svg", pub));
const maskable = await readFile(new URL("icon-maskable.svg", pub));

const jobs = [
  [regular, 192, "icon-192.png"],
  [regular, 512, "icon-512.png"],
  [maskable, 512, "icon-maskable-512.png"],
  [regular, 180, "apple-touch-icon.png"],
];
for (const [src, size, name] of jobs) {
  await writeFile(new URL(name, pub), await sharp(src, { density: 384 }).resize(size, size).png().toBuffer());
  console.log(`wrote ${name} (${size}x${size})`);
}
