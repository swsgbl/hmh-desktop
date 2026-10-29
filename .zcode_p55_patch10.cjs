const fs = require('fs');
const p = 'D:/BrowserOS - KaihongOS/entry/src/main/ets/pages/BrowserShell.ets';
let t = fs.readFileSync(p, 'utf8');

// 1) add urlLoadedSet field next to attachedTabs
const a1 = 'private attachedTabs: Set<string> = new Set()';
const i1 = t.indexOf(a1);
if (i1 < 0) { console.log('attachedTabs anchor missing'); process.exit(1); }
if (t.indexOf('urlLoadedTabs') < 0) {
  t = t.substring(0, i1 + a1.length) + '\n  /** P55: tabs whose URL was already loaded into their Web component (avoid double-load) */\n  private urlLoadedTabs: Set<string> = new Set()' + t.substring(i1 + a1.length);
}

// 2) in onControllerAttached, after registerController(tabId), load currentUrl if not blank and not yet loaded
const a2re = /this\.attachedTabs\.add\(tabId\)\r?\n\s+this\.registerController\(tabId\)/;
const m2 = t.match(a2re);
if (!m2) { console.log('attach block anchor missing'); process.exit(1); }
const a2 = m2[0];
const i2 = t.indexOf(a2);
const insPlain = a2 + "\n            // P55: MCP-created tabs carry a URL in TabManager but nothing dispatched it.\n" +
  "            // On attach, if the tab already has a real URL and we have not loaded one yet, load it.\n" +
  "            if (!this.urlLoadedTabs.has(tabId)) {\n" +
  "              const mTab = TabManager.getTab(tabId)\n" +
  "              const mUrl = mTab ? mTab.currentUrl : ''\n" +
  "              if (mUrl.length > 0 && mUrl !== 'about:blank') {\n" +
  "                this.urlLoadedTabs.add(tabId)\n" +
  "                try {\n" +
  "                  this.getControllerFor(tabId)?.loadUrl(mUrl)\n" +
  "                  console.info('BrowserShell P55 attach-load: ' + mUrl + ' tab=' + tabId)\n" +
  "                } catch (e) {\n" +
  "                  console.error('BrowserShell P55 attach-load error: ' + e)\n" +
  "                }\n" +
  "              }\n" +
  "            }";
t = t.substring(0, i2) + insPlain + t.substring(i2 + a2.length);

// 3) also mark urlLoadedTabs when pendingUrl/restoreUrl load paths fire (they already load a URL)
const a3 = "this.getControllerFor(tabId)?.loadUrl(url)";
const i3 = t.indexOf(a3);
if (i3 >= 0) {
  t = t.substring(0, i3 + a3.length) + '\n              this.urlLoadedTabs.add(tabId)' + t.substring(i3 + a3.length);
}
const a4 = "this.getControllerFor(tabId)?.loadUrl(rUrl)";
const i4 = t.indexOf(a4);
if (i4 >= 0) {
  t = t.substring(0, i4 + a4.length) + '\n                this.urlLoadedTabs.add(tabId)' + t.substring(i4 + a4.length);
}

fs.writeFileSync(p, t);
console.log('BROWSERSHELL P55 PATCHED len', t.length);
