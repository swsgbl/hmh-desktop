const fs = require('fs');
const p = 'D:/BrowserOS - KaihongOS/entry/src/main/ets/service/MCPServer.ets';
let t = fs.readFileSync(p, 'utf8');

// 1) import TabGroupManager after TabManager import
{
  const a = "import { TabManager } from './TabManager'";
  const i = t.indexOf(a);
  if (i < 0) { console.log('import anchor missing'); process.exit(1); }
  t = t.substring(0, i + a.length) + "\nimport { TabGroupManager } from './TabGroupManager'" + t.substring(i + a.length);
}

// 2) replace handleTabGroups + collectTabGroups block entirely
const startMarker = 'private handleTabGroups: ToolHandler';
const endMarker = '// ---------- [P43] history';
const s = t.indexOf(startMarker);
const e = t.indexOf(endMarker);
if (s < 0 || e < 0 || e <= s) { console.log('tabgroups block not found', s, e); process.exit(1); }
const commentStart = t.lastIndexOf('// ----------', s); // section comment above handler
const newBlock = [
  '// ---------- [P55] tab_groups: named groups (create/join/leave/list/ungroup) via TabGroupManager ----------',
  '',
  '  private handleTabGroups: ToolHandler = async (params, agentId) => {',
  "    const action = params['action'] as string || 'list'",
  "    if (action === 'list') {",
  '      const groups = TabGroupManager.list()',
  '      const lines: McpGroupLine[] = []',
  '      for (const g of groups) {',
  '        const line = new McpGroupLine()',
  '        line.group = g.name',
  '        line.tabIds = g.tabIds.slice()',
  '        lines.push(line)',
  '      }',
  "      const recGl: Record<string, Object> = { 'groups': lines, 'count': lines.length }",
  '    return this.okResponse(recGl)',
  '    }',
  "    if (action === 'create') {",
  "      const name = params['name'] as string",
  '      if (!name) {',
  "        return this.errorResponse(ErrorCodes.MCP_003, 'tab_groups create: name is required')",
  '      }',
  '      const g = TabGroupManager.create(name)',
  '      if (!g) {',
  "        return this.errorResponse(ErrorCodes.MCP_003, 'tab_groups create: invalid name')",
  '      }',
  "      const recGc: Record<string, Object> = { 'groupId': g.groupId, 'name': g.name, 'tabIds': g.tabIds.length }",
  '    return this.okResponse(recGc)',
  '    }',
  "    if (action === 'join') {",
  "      const group = (params['group'] as string) || (params['name'] as string)",
  "      const tabIdsRaw = params['tabIds']",
  "      const tabId = params['tabId'] as string",
  "      const ids: string[] = []",
  '      if (tabIdsRaw !== undefined && tabIdsRaw !== null) {',
  '        const arr = tabIdsRaw as Object[]',
  '        if (Array.isArray(arr)) {',
  '          for (const x of arr) { ids.push(`${x}`) }',
  '        }',
  '      }',
  '      if (tabId) {',
  '        ids.push(tabId)',
  '      }',
  '      if (!group || ids.length === 0) {',
  "        return this.errorResponse(ErrorCodes.MCP_003, 'tab_groups join: group and tabIds (or tabId) are required')",
  '      }',
  '      const g = TabGroupManager.findByName(group)',
  '      if (!g) {',
  "        return this.errorResponse(ErrorCodes.MCP_003, `tab_groups join: no such group ${group}`)",
  '      }',
  '      let joined = 0',
  '      const failed: string[] = []',
  '      for (const id of ids) {',
  '        if (TabGroupManager.join(g.groupId, id)) {',
  '          joined++',
  '        } else {',
  '          failed.push(id)',
  '        }',
  '      }',
  "      const recGj: Record<string, Object> = { 'group': group, 'joined': joined, 'failed': failed }",
  '    return this.okResponse(recGj)',
  '    }',
  "    if (action === 'leave') {",
  "      const group = (params['group'] as string) || (params['name'] as string)",
  "      const tabId = params['tabId'] as string",
  '      if (!group || !tabId) {',
  "        return this.errorResponse(ErrorCodes.MCP_003, 'tab_groups leave: group and tabId are required')",
  '      }',
  '      const g = TabGroupManager.findByName(group)',
  '      if (!g) {',
  "        return this.errorResponse(ErrorCodes.MCP_003, `tab_groups leave: no such group ${group}`)",
  '      }',
  '      const ok = TabGroupManager.leave(g.groupId, tabId)',
  '      if (!ok) {',
  "        return this.errorResponse(ErrorCodes.MCP_003, `tab_groups leave: tab ${tabId} not in group ${group}`)",
  '      }',
  "      const recGlv: Record<string, Object> = { 'group': group, 'tabId': tabId, 'left': true }",
  '    return this.okResponse(recGlv)',
  '    }',
  "    if (action === 'ungroup') {",
  "      const group = (params['group'] as string) || (params['name'] as string)",
  '      if (!group) {',
  "        return this.errorResponse(ErrorCodes.MCP_003, 'tab_groups ungroup: group is required')",
  '      }',
  '      const g = TabGroupManager.findByName(group)',
  '      if (!g) {',
  "        return this.errorResponse(ErrorCodes.MCP_003, `tab_groups ungroup: no such group ${group}`)",
  '      }',
  '      const kept = g.tabIds.slice()',
  '      const ok = TabGroupManager.ungroup(g.groupId)',
  '      if (!ok) {',
  "        return this.errorResponse(ErrorCodes.MCP_003, `tab_groups ungroup: failed for ${group}`)",
  '      }',
  "      const recGu: Record<string, Object> = { 'group': group, 'ungrouped': true, 'keptTabs': kept.length }",
  '    return this.okResponse(recGu)',
  '    }',
  "    return this.errorResponse(ErrorCodes.MCP_003, `tab_groups: unsupported action ${action}`)",
  '  }',
  '',
  '  '
].join('\n');
t = t.substring(0, commentStart) + newBlock + t.substring(e);

// 3) tabs close -> cleanupTab
{
  const a2 = "McpSessionStore.releaseTab(sessionId, tabId)";
  const i = t.indexOf(a2);
  if (i < 0) { console.log('close anchor missing'); process.exit(1); }
  // insert after the closing "}" of "if (sessionId) {...}" — find next "}" after releaseTab
  const closeBrace = t.indexOf('}', i);
  t = t.substring(0, closeBrace + 1) + "\n      // P55: tab removed from any named group on close\n      TabGroupManager.cleanupTab(tabId)" + t.substring(closeBrace + 1);
}

fs.writeFileSync(p, t);
console.log('TABGROUPS WIRED len', t.length);
