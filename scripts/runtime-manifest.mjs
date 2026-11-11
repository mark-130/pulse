// Writes the runtime image's package.json (D66). The runtime stage installs better-sqlite3 with npm, so this pins it, and
// everything it depends on, to the exact versions pnpm-lock.yaml resolved for the build. Run in the build stage after
// `pnpm install --frozen-lockfile`: Usage: node scripts/runtime-manifest.mjs <out-dir>
import { readFileSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const out = process.argv[2];
if (!out) throw new Error("Usage: node scripts/runtime-manifest.mjs <out-dir>");
const api = join(process.cwd(), "apps/api");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const wanted = readJson(join(api, "package.json")).dependencies["better-sqlite3"];
if (!wanted) throw new Error("better-sqlite3 is not an apps/api dependency");

/** Finds the installed package.json of `name`, as seen from the directory `from`. */
function installed(name, from) {
  const req = createRequire(join(from, "noop.js"));
  let dir = dirname(req.resolve(`${name}/package.json`, { paths: [from] }));
  return { dir: realpathSync(dir), pkg: readJson(join(realpathSync(dir), "package.json")) };
}

const root = installed("better-sqlite3", api);
const versions = new Map([["better-sqlite3", new Set([root.pkg.version])]]);
const seen = new Set();
(function walk({ dir, pkg }) {
  if (seen.has(dir)) return;
  seen.add(dir);
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    const d = installed(dep, dir);
    if (!versions.has(dep)) versions.set(dep, new Set());
    versions.get(dep).add(d.pkg.version);
    walk(d);
  }
})(root);

// An override is only safe when the lockfile has one version of that package.
const overrides = {};
for (const [name, set] of versions) if (name !== "better-sqlite3" && set.size === 1) overrides[name] = [...set][0];

const manifest = { name: "pulse-runtime", private: true, type: "module", dependencies: { "better-sqlite3": root.pkg.version }, ...(Object.keys(overrides).length ? { overrides } : {}) };
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "package.json"), JSON.stringify(manifest));
console.log(`runtime manifest: better-sqlite3 ${root.pkg.version} (wanted ${wanted}), ${Object.keys(overrides).length} pinned dependencies`);
