/**
 * 把 fake host 打成自包含 cjs(捆绑 @hmh-desktop/contracts),供打包产品的
 * 开发演示模式使用:安装包里的 electron.exe 以 ELECTRON_RUN_AS_NODE=1 直跑。
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [join(root, 'packages', 'host-adapter', 'src', 'fake-host.ts')],
  outfile: join(root, 'apps', 'desktop', 'resources', 'fake-host.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  external: ['electron'],
  logLevel: 'info',
});
console.log('fake-host.cjs → apps/desktop/resources/(自包含,无需 tsx)');
