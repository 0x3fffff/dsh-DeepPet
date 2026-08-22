// 把 `pnpm tauri build --no-bundle` 产出的二进制放进当前平台的发布包。
// 本地开发和 CI 都用它，保证两边路径一致。
// 用法：node scripts/stage-binary.mjs
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 平台 → [发布包目录, 二进制文件名]。新增平台时在这里加一行。 */
const TARGETS = {
  "win32-x64": ["win32-x64", "dsh-deep-pet.exe"],
};

const key = `${process.platform}-${process.arch}`;
const target = TARGETS[key];
if (!target) {
  console.error(`no release package for ${key}`);
  process.exit(1);
}
const [pkgDir, binName] = target;

const src = join(root, "pet", "src-tauri", "target", "release", binName);
if (!existsSync(src)) {
  console.error(`binary not built: ${src}\nrun: cd pet && pnpm build && pnpm tauri build --no-bundle`);
  process.exit(1);
}

const destDir = join(root, "packages", pkgDir, "bin");
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, binName);
copyFileSync(src, dest);
console.log(`staged ${key}: ${dest}`);
