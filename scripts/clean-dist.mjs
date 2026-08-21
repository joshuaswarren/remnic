import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function removeDist(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

removeDist(path.join(root, "dist"));

const packagesDir = path.join(root, "packages");
let packageEntries = [];
try {
  packageEntries = fs.readdirSync(packagesDir);
} catch (error) {
  if (error?.code === "ENOENT") {
    process.exit(0);
  }
  throw error;
}

for (const entry of packageEntries) {
  const packageDir = path.join(packagesDir, entry);
  const stat = fs.lstatSync(packageDir);
  if (!stat.isDirectory()) continue;

  removeDist(path.join(packageDir, "dist"));
}
