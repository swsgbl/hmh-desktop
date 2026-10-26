/**
 * M6 打包链路:renderer + electron 构建 → fake-host 自包含 cjs → NSIS 安装包。
 * 代码签名证书未配置(signing = NOT RUN,发布前需补)。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });

// 1) fake host 自包含 bundle(resources/,asar 外)
await run(process.execPath, ['scripts/bundle-fake-host.mjs']);
// 1b) v5 内置 runtime bundle(hmharness desktop-host → resources/runtime/,asar 外)
await run(process.execPath, ['scripts/bundle-runtime.mjs']);
// 2) renderer + electron
await run(process.execPath, ['scripts/build.mjs']);
// 3) NSIS(electron-builder;二进制走镜像;config 用绝对路径——相对路径会被
//    projectDir 再拼一次)
await run(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--config', join(root, 'apps', 'desktop', 'electron-builder.yml'), '--projectDir', 'apps/desktop'], {
  env: {
    ...process.env,
    ELECTRON_MIRROR: 'https://cdn.npmmirror.com/binaries/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: 'https://cdn.npmmirror.com/binaries/electron-builder-binaries/',
  },
});
console.log('打包完成:apps/desktop/release/');
