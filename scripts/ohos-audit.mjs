/** 鸿蒙版功能面盘点(对齐 Windows 版矩阵)。 */
import { readdirSync, readFileSync, statSync } from 'node:fs';

const dir = 'G:/hmh-desktop/apps/ohos/entry/src/main/ets';
const feats = {
  工具折叠卡: /tool-?card|ToolCard/i,
  交付物卡: /artifact|交付物/i,
  回合汇总: /turn-?sum|回合/i,
  收藏: /pinned|收藏/i,
  会话分组: /ws-?group|groupBy|分组/i,
  状态过滤: /statusFilter|filter/i,
  导出: /export/i,
  归档删除: /archive|归档/i,
  图片附件: /photo|相册|PhotoView|ImagePicker/i,
  模型选择: /modelList|switchModel|模型切换/i,
  审批模式: /approvalMode/i,
  Provider设置: /providerSave|providersDetail/i,
  主题: /theme|ColorMode/i,
  i18n: /locale|English/i,
  总览页: /Overview|总览/i,
  日志页: /logs|日志/i,
  通知: /notification/i,
  preferences持久: /preferences/i,
};
const files = [];
const w = (d) => {
  for (const f of readdirSync(d)) {
    const p = `${d}/${f}`;
    if (statSync(p).isDirectory()) { w(p); continue; }
    if (f.endsWith('.ets') || f.endsWith('.ts')) files.push(p);
  }
};
w(dir);
for (const [name, re] of Object.entries(feats)) {
  const hits = files.filter((f) => re.test(readFileSync(f, 'utf8')));
  console.log(`${name}: ${hits.length > 0 ? '有' : '缺'}(${hits.length})`);
}
