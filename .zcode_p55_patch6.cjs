const fs = require('fs');
const p = 'D:/BrowserOS - KaihongOS/entry/src/main/ets/service/MCPServer.ets';
let t = fs.readFileSync(p, 'utf8');

if (t.indexOf('private handleWindows:') >= 0) {
  console.log('windows handler already present — skip');
  process.exit(0);
}

const anchor = '// ---------- [P55] evaluate: hardened';
const i = t.indexOf(anchor);
if (i < 0) { console.log('EVAL ANCHOR NOT FOUND'); process.exit(1); }

const newWin = [
  '// ---------- [P55] windows: single-window build (list with full tabs; focus ok; new/close unsupported) ----------',
  '',
  '  private handleWindows: ToolHandler = async (params, agentId) => {',
  "    const action = params['action'] as string || 'list'",
  "    if (action === 'list') {",
  '      const tabs = TabManager.getAllTabs()',
  '      const activeId = TabManager.getActiveTabId()',
  '      const tabLines: McpTabLine[] = []',
  '      for (const t2 of tabs) {',
  '        const line = new McpTabLine()',
  '        line.tabId = t2.tabId',
  '        line.url = t2.currentUrl',
  '        line.title = t2.title',
  '        line.active = t2.tabId === activeId',
  '        tabLines.push(line)',
  '      }',
  "      const recWin: Record<string, Object> = { 'windows': [{ windowId: 'main', tabs: tabLines, tabCount: tabLines.length }] }",
  '    return this.okResponse(recWin)',
  '    }',
  "    if (action === 'focus') {",
  "      const recWf: Record<string, Object> = { 'success': true, 'note': 'single window mode' }",
  '    return this.okResponse(recWf)',
  '    }',
  "    if (action === 'new' || action === 'close') {",
  "      return this.errorResponse(ErrorCodes.MCP_003, `windows ${action}: unsupported on single-window platform`)",
  '    }',
  "    return this.errorResponse(ErrorCodes.MCP_003, `windows: unsupported action ${action}`)",
  '  }',
  '',
  '  '
].join('\n');

t = t.substring(0, i) + newWin + t.substring(i);
fs.writeFileSync(p, t);
console.log('WINDOWS RESTORED len', t.length, 'handler at', t.indexOf('private handleWindows:'));
