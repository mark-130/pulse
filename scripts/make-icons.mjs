// Generates placeholder PWA icons (accent square, white pulse line). Replace with real artwork later.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const bg = [11, 15, 20], fg = [56, 189, 248];
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // pulse line: flat, spike up, spike down, flat
      const pts = [[0.12, 0.5], [0.35, 0.5], [0.43, 0.25], [0.55, 0.75], [0.63, 0.5], [0.88, 0.5]];
      let on = false;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
        const t = Math.max(0, Math.min(1, ((u - x1) * (x2 - x1) + (v - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2)));
        if (Math.hypot(u - (x1 + t * (x2 - x1)), v - (y1 + t * (y2 - y1))) < 0.035) on = true;
      }
      row.set(on ? fg : bg, 1 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
const out = new URL("../apps/web/public/", import.meta.url);
writeFileSync(new URL("icon-192.png", out), png(192));
writeFileSync(new URL("icon-512.png", out), png(512));
writeFileSync(new URL("apple-touch-icon.png", out), png(180));
writeFileSync(new URL("icon.svg", out), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0b0f14"/><polyline points="12,50 35,50 43,25 55,75 63,50 88,50" fill="none" stroke="#38bdf8" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`);
