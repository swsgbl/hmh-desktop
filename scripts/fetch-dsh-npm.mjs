/** 拉 DSH Web UI npm 包 tarball 并解出 CSS。 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const out = 'G:/hmh-desktop/evidence/dsh/src';
mkdirSync(out, { recursive: true });
for (const pkg of ['dsh-web-frontend', 'dsh-web-app', 'dsh-client-ui-chat']) {
  try {
    const meta = await (await fetch(`https://registry.npmjs.org/@deepseek-ai/${pkg}`)).json();
    const v = meta['dist-tags']?.latest ?? Object.keys(meta.versions ?? {}).pop();
    if (v === undefined) { console.log(pkg, 'no version'); continue; }
    const tar = meta.versions[v].dist.tarball;
    const r = await fetch(tar);
    const b = Buffer.from(await r.arrayBuffer());
    writeFileSync(`G:/hmh-desktop/.hm-tmp/${pkg}.tgz`, b);
    console.log(pkg, v, b.length, 'bytes');
    try {
      execFileSync('tar', ['-xzf', `G:/hmh-desktop/.hm-tmp/${pkg}.tgz`, '-C', 'G:/hmh-desktop/.hm-tmp'], { timeout: 30000 });
      console.log(pkg, 'extracted');
    } catch (e) { console.log(pkg, 'extract fail'); }
  } catch (e) {
    console.log(pkg, 'FAIL', String(e).slice(0, 80));
  }
}
