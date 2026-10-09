// 手动执行 electron 的 install.js(下载平台二进制到 node_modules/electron/dist),
// ELECTRON_MIRROR 指向 npmmirror CDN(与 .npmrc 的 electron_mirror 同源)。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(process.execPath, [join(root, 'node_modules', 'electron', 'install.js')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_MIRROR: 'https://cdn.npmmirror.com/binaries/electron/' },
});
process.exit(r.status ?? 1);
