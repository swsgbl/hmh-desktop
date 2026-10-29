const fs = require('fs');
const p = 'D:/BrowserOS - KaihongOS/entry/src/main/ets/protocol/SnapshotGenerator.ets';
let t = fs.readFileSync(p, 'utf8');
// normalize to LF for matching, keep result in LF (git autocrlf tolerant)
const anchor = "const result = await BCPEngine.snapshotMarkdown()";
const idx = t.indexOf(anchor);
if (idx < 0) { console.log('ANCHOR NOT FOUND'); process.exit(1); }
const endMarker = "    return result\n  }";
// find "return result" after anchor
const retIdx = t.indexOf("return result", idx);
if (retIdx < 0) { console.log('RETURN NOT FOUND'); process.exit(1); }
// find closing "  }" after return
const closeIdx = t.indexOf("}", retIdx);
const repl = [
  "const mdResult = await BCPEngine.snapshotMarkdown()",
  "    if (!mdResult.success) {",
  "      timer()",
  "      return mdResult",
  "    }",
  "    // P55: refs JSON string collected inline (empty on failure; snapshot still usable)",
  "    const md = `${mdResult.data}`",
  "    let refsJson = ''",
  "    try {",
  "      const refsResult = await BCPEngine.collectRefs()",
  "      if (refsResult.success && refsResult.data) {",
  "        refsJson = `${refsResult.data}`",
  "      }",
  "    } catch (e) {",
  "      console.warn('[SnapshotGenerator] collectRefs failed: ' + e)",
  "    }",
  "    const combined: Record<string, Object> = { 'content': md, 'refs': refsJson }",
  "    let combinedStr = md",
  "    try {",
  "      combinedStr = JSON.stringify(combined)",
  "    } catch (e) {",
  "    }",
  "    timer()",
  "    if (combinedStr.length > 0) {",
  "      PerformanceMonitor.record('snapshot_original_size', combinedStr.length, 'Snapshot')",
  "      PerformanceMonitor.record('snapshot_compressed_size', combinedStr.length, 'Snapshot')",
  "      PerformanceMonitor.record('snapshot_compression_ratio', 1.0, 'Snapshot')",
  "    }",
  "    return { success: true, data: combinedStr, error: null }"
].join('\n');
t = t.substring(0, idx) + repl + t.substring(closeIdx);
fs.writeFileSync(p, t);
console.log('OK newlen', t.length);
