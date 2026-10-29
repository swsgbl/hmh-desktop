const fs = require('fs');
const p = 'D:/BrowserOS - KaihongOS/entry/src/main/ets/service/MCPServer.ets';
let t = fs.readFileSync(p, 'utf8');

// 1) add McpWindowDetail class after McpWindowLine class
{
  const a = "/** [P43] windows list 行（单窗口形态） */\nclass McpWindowLine {\n  windowId: string = ''\n  tabs: number = 0\n}";
  // CRLF-safe: match via regex
  const re = /\/\*\* \[P43\] windows[^\n]*\*\/\nclass McpWindowLine \{\n  windowId: string = ''\n  tabs: number = 0\n\}/;
  if (!re.test(t)) {
    // try CRLF variant
    const re2 = /class McpWindowLine \{[\s\S]*?\n\}/;
    if (!re2.test(t)) { console.log('winline class not found'); process.exit(1); }
    const m = t.match(re2);
    t = t.replace(re2, m[0] + "\n\n/** [P55] windows list 详情（含完整 tab 行） */\nclass McpWindowDetail {\n  windowId: string = ''\n  tabs: McpTabLine[] = []\n  tabCount: number = 0\n}");
  } else {
    t = t.replace(re, a + "\n\n/** [P55] windows list 详情（含完整 tab 行） */\nclass McpWindowDetail {\n  windowId: string = ''\n  tabs: McpTabLine[] = []\n  tabCount: number = 0\n}");
  }
  console.log('class added');
}

// 2) use typed instance in handleWindows list
{
  const old = "      const recWin: Record<string, Object> = { 'windows': [{ windowId: 'main', tabs: tabLines, tabCount: tabLines.length }] }";
  const i = t.indexOf(old);
  if (i < 0) { console.log('recWin not found'); process.exit(1); }
  const neu = "      const winDetail = new McpWindowDetail()\n" +
    "      winDetail.windowId = 'main'\n" +
    "      winDetail.tabs = tabLines\n" +
    "      winDetail.tabCount = tabLines.length\n" +
    "      const winArr: McpWindowDetail[] = [winDetail]\n" +
    "      const recWin: Record<string, Object> = { 'windows': winArr }";
  t = t.substring(0, i) + neu + t.substring(i + old.length);
  console.log('recWin fixed');
}

fs.writeFileSync(p, t);
console.log('DONE len', t.length);
