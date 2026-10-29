const fs = require('fs');
const p = 'D:/BrowserOS - KaihongOS/entry/src/main/ets/service/MCPServer.ets';
let t = fs.readFileSync(p, 'utf8');

function patch(name, anchor, insertBefore, insertText) {
  const idx = t.indexOf(anchor);
  if (idx < 0) { console.log(name + ': ANCHOR NOT FOUND'); process.exit(1); }
  t = t.substring(0, idx) + insertText + t.substring(idx);
  console.log(name + ': OK');
}

// ---- Patch 1: handleSnapshot -> composite {content, refs} ----
const snapAnchor = "private handleSnapshot: ToolHandler = async (params, agentId) => {";
const snapNew = [
  "private handleSnapshot: ToolHandler = async (params, agentId) => {",
  "    const result = await SnapshotGenerator.generate()",
  "    if (!result.success) {",
  "      const dataFail: MCPResponseData = { result: result.data === null ? null : `${result.data}` }",
  "      return this.bcpToMcpResponse(result, dataFail)",
  "    }",
  "    // P55: data is {content, refs} JSON; refs string needs second parse into array",
  "    let content = ''",
  "    let refs: Object[] = []",
  "    try {",
  "      const parsed = JSON.parse(`${result.data}`) as Record<string, Object>",
  "      content = `${parsed['content'] || ''}`",
  "      const refsRaw = `${parsed['refs'] || ''}`",
  "      if (refsRaw.length > 0) {",
  "        const arr = JSON.parse(refsRaw) as Record<string, Object>[]",
  "        if (Array.isArray(arr)) {",
  "          refs = arr",
  "        }",
  "      }",
  "    } catch (e) {",
  "      content = `${result.data}`",
  "    }",
  "    const recSnap: Record<string, Object> = { 'content': content, 'refs': refs, 'refCount': refs.length }",
  "    const snapResp: MCPToolResponse = {",
  "      status: 'success', data: recSnap, error: null, requestId: this.generateRequestId()",
  "    }",
  "    return snapResp",
  "  }",
  ""
].join('\n');
{
  const idx = t.indexOf(snapAnchor);
  if (idx < 0) { console.log('snap: ANCHOR NOT FOUND'); process.exit(1); }
  // find end of old handler: "return this.bcpToMcpResponse(result, data)\n  }" starting after anchor
  const bodyEnd = t.indexOf("return this.bcpToMcpResponse(result, data)", idx);
  if (bodyEnd < 0) { console.log('snap: BODY END NOT FOUND'); process.exit(1); }
  const closeIdx = t.indexOf("}", bodyEnd); // closing "  }" of handler
  // advance to the "}" that closes handler method (first '}' after return statement is '  }' same line? return ends with newline '  }')
  t = t.substring(0, idx) + snapNew + t.substring(closeIdx);
  console.log('snap: OK');
}

// ---- Patch 2: act selector/ref normalization (e<N> -> [data-bcp-ref="eN"]) ----
{
  const anchor = "const ref = (params['ref'] as string) || (params['selector'] as string)";
  const idx = t.indexOf(anchor);
  if (idx < 0) { console.log('actref: ANCHOR NOT FOUND'); process.exit(1); }
  const addition = [
    "const ref = (params['ref'] as string) || (params['selector'] as string)",
    "    // P55: Stable SnapshotRef - e<N> refs from snapshot resolve to [data-bcp-ref] CSS selector",
    "    if (ref && /^e\\d+$/.test(ref)) {",
    "      selectorArg = `[data-bcp-ref=\"${ref}\"]`",
    "    } else if (ref) {",
    "      selectorArg = ref",
    "    } else {",
    "      selectorArg = ''",
    "    }",
    "    const sel = selectorArg"
  ].join('\n');
  t = t.substring(0, idx) + addition + t.substring(idx + anchor.length);
  console.log('actref: OK');
}

fs.writeFileSync(p, t);
console.log('ALL DONE, newlen', t.length);
