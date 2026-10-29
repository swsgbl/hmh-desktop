const fs = require('fs');
const p = 'D:/BrowserOS - KaihongOS/entry/src/main/ets/service/TabManager.ets';
let t = fs.readFileSync(p, 'utf8');
const anchor = "AuditEventBus.record(AUDIT_INTERNAL_SESSION, tabId, AuditEventType.TAB_CREATED, '', 'ok', 0, isDashboard ? 'dashboard' : 'normal', '', '')";
const i = t.indexOf(anchor);
if (i < 0) { console.log('ANCHOR NOT FOUND'); process.exit(1); }
// only patch the FIRST occurrence (createTab); createAgentTab has its own record call with 'agent'
const ins = "    // P55 fix: tab must enter the registry before TAB_STATUS_CHANGE emits,\n" +
  "    // otherwise UI ForEach re-render + switchTab see 'Tab not found' and the Web\n" +
  "    // component never renders -> MCP tabs.new -> navigate/snapshot all fail\n" +
  "    this.tabs.set(tabId, tab)\n\n" +
  "    " + anchor;
t = t.substring(0, i) + ins + t.substring(i + anchor.length);
fs.writeFileSync(p, t);
console.log('TABS.SET FIXED');
