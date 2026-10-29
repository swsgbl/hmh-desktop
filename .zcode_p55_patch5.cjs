const fs = require('fs');

// ---- 1) EntryAbility: TabGroupManager.setContext after TabManager.setContext ----
{
  const p = 'D:/BrowserOS - KaihongOS/entry/src/main/ets/entryability/EntryAbility.ets';
  let t = fs.readFileSync(p, 'utf8');
  const a = 'TabManager.setContext(this.context)';
  const i = t.indexOf(a);
  if (i < 0) { console.log('EA anchor missing'); process.exit(1); }
  if (t.indexOf('TabGroupManager.setContext') < 0) {
    t = t.substring(0, i + a.length) + '\n      // P55: named tab groups persistence context\n      TabGroupManager.setContext(this.context)' + t.substring(i + a.length);
    // add import
    const imp = "import { TabManager } from '../service/TabManager'";
    const ii = t.indexOf(imp);
    if (ii < 0) { console.log('EA import anchor missing'); process.exit(1); }
    t = t.substring(0, ii + imp.length) + "\nimport { TabGroupManager } from '../service/TabGroupManager'" + t.substring(ii + imp.length);
  }
  fs.writeFileSync(p, t);
  console.log('EA OK');
}

// ---- 2) MCPServer: windows list with full tabs; evaluate hardening ----
{
  const p = 'D:/BrowserOS - KaihongOS/entry/src/main/ets/service/MCPServer.ets';
  let t = fs.readFileSync(p, 'utf8');

  // windows: replace handler
  const ws = t.indexOf('private handleWindows');
  const we = t.indexOf('private handleEvaluate');
  if (ws < 0 || we < 0 || we <= ws) { console.log('windows block missing'); process.exit(1); }
  const commentStart = t.lastIndexOf('// ----------', ws);
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
  t = t.substring(0, commentStart) + newWin + t.substring(we);
  console.log('windows OK');

  // evaluate: hardening (timeout 10s via Promise.race; 64KB truncation; location nav ban)
  const es = t.indexOf('private handleEvaluate');
  const ee = t.indexOf('private handleRun');
  if (es < 0 || ee < 0 || ee <= es) { console.log('evaluate block missing'); process.exit(1); }
  const commentStart2 = t.lastIndexOf('// ----------', es);
  const newEval = [
    '// ---------- [P55] evaluate: hardened (10s timeout, 64KB truncation, navigation ban) ----------',
    '',
    '  private static readonly EVAL_TIMEOUT_MS: number = 10000',
    '  private static readonly EVAL_MAX_RESULT: number = 65536',
    '',
    '  private handleEvaluate: ToolHandler = async (params, agentId) => {',
    "    const expression = params['expression'] as string",
    '    if (!expression) {',
    "      return this.errorResponse(ErrorCodes.MCP_003, 'evaluate: expression is required')",
    '    }',
    '    // P55: ban navigation via location assignment (use navigate tool instead)',
    "    if (/(?:window\\.)?location\\s*(?:\\.href\\s*=[^=]|\\.assign|\\.replace\\s*\\()/.test(expression)) {",
    "      return this.errorResponse(ErrorCodes.MCP_003, 'evaluate: navigation via window.location is banned; use the navigate tool')",
    '    }',
    '    // P55: 10s timeout via Promise.race',
    '    let evalPromise = BCPEngine.evaluate(expression)',
    '    let timeoutHit = false',
    '    const timeoutPromise = new Promise<BCPResult>((resolve) => {',
    '      setTimeout(() => {',
    '        timeoutHit = true',
    "        resolve({ success: false, data: null, error: 'evaluate timeout after 10s' })",
    `      }, MCPServerImpl.EVAL_TIMEOUT_MS)`,
    '    })',
    '    const result = await Promise.race([evalPromise, timeoutPromise])',
    '    if (timeoutHit) {',
    "      return this.errorResponse(ErrorCodes.MCP_003, 'evaluate: timed out after 10s')",
    '    }',
    '    if (!result.success) {',
    '      return this.bcpToMcpResponse(result, {})',
    '    }',
    '    // P55: 64KB result cap with truncation marker',
    '    let resultStr = result.data === null ? \'\' : `${result.data}`',
    '    let truncated = false',
    '    if (resultStr.length > MCPServerImpl.EVAL_MAX_RESULT) {',
    '      resultStr = resultStr.substring(0, MCPServerImpl.EVAL_MAX_RESULT)',
    '      truncated = true',
    '    }',
    "    const recEv: Record<string, Object> = { 'expression': expression, 'result': resultStr, 'truncated': truncated }",
    '    const evResp: MCPToolResponse = {',
    '      status: \'success\', data: recEv, error: null, requestId: this.generateRequestId()',
    '    }',
    '    return evResp',
    '  }',
    '',
    '  '
  ].join('\n');
  t = t.substring(0, commentStart2) + newEval + t.substring(ee);
  console.log('evaluate OK');

  fs.writeFileSync(p, t);
  console.log('MCP WIN/EVAL DONE len', t.length);
}
