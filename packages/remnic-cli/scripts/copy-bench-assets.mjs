import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const assets = [
  {
    from: path.join(pkgRoot, "assets", "download-datasets.sh"),
    to: path.join(pkgRoot, "dist", "assets", "download-datasets.sh"),
    mode: 0o755,
  },
];

for (const asset of assets) {
  if (!fs.existsSync(asset.from)) {
    console.error(`[copy-bench-assets] source not found: ${asset.from}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(asset.to), { recursive: true });
  fs.copyFileSync(asset.from, asset.to);
  fs.chmodSync(asset.to, asset.mode);
  console.log(`[copy-bench-assets] ${path.relative(pkgRoot, asset.from)} → ${path.relative(pkgRoot, asset.to)}`);
}
