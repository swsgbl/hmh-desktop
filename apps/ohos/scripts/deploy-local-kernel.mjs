#!/usr/bin/env node
/**
 * v6/v6.1 — 设备本地内核一键部署(KaihongOS VM/设备)
 *
 * 在 PC 端运行,把 hmh 内核装到设备并起 web 服务(0.0.0.0:7788),
 * 随后鸿蒙桌面应用以 http://127.0.0.1:7788 直连 → 与设备 TUI/浏览器三端同核。
 *
 * 用法:
 *   node scripts/deploy-local-kernel.mjs [--target 192.168.161.137:10178]
 *        [--token-env HMH_WEB_TOKEN]   # 设备 web 密钥来源(环境变量,绝不进命令行参数/日志)
 *        [--arch x64|arm]              # node 二进制架构(默认 x64;arm 设备需换 arm 版 node)
 *        [--skip-install]              # 跳过安装(已装过,只做 fix-launcher+起服务)
 *        [--restart-web]               # 只重启 web(改配置后)
 *
 * 已知边界(如实):
 *   - 设备侧独立 HMH_HOME(/data/local/home/.hmharness),与 PC 不共享会话;
 *   - 侧载形态(非应用市场),需开发者模式;
 *   - 本 VM root 的 hdc shell 也禁 RWX → 启动器强制 --jitless(NODE_ALLOW_JIT=0 可覆盖);
 *   - arm 设备需自备 arm node 二进制(--arch arm 时要求 HMH_ARM_NODE 指向 tar 路径)。
 *
 * 退出码: 0=成功; 1=失败(见 stderr)。
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d
}

const TARGET = opt('--target', '192.168.161.137:10178')
const ARCH = opt('--arch', 'x64')
const TOKEN_ENV = opt('--token-env', 'HMH_WEB_TOKEN')
const SKIP_INSTALL = flag('--skip-install')
const RESTART_WEB = flag('--restart-web')

const DEV_NODE = '/data/local/home/.ohos/node/bin/node'
const HMH = '/data/local/home/.local/bin/hmh'
const INSTALLER = 'G:\\hmharness\\scripts\\install-kaihongos.cjs'

function sh(cmd, timeoutMs = 60000) {
  try {
    return execSync(`hdc -t ${TARGET} shell "${cmd}"`, {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64e6
    }).trim()
  } catch (e) {
    return 'ERR: ' + String(e.stdout || e.stderr || e.message).slice(0, 300)
  }
}
function send(local, remote) {
  try {
    return execSync(`hdc -t ${TARGET} file send "${local}" "${remote}"`, {
      encoding: 'utf8', timeout: 120000
    }).trim()
  } catch (e) {
    return 'ERR: ' + String(e.message).slice(0, 200)
  }
}
const ok = (s) => !String(s).startsWith('ERR')

// ---------------------------------------------------------------------------
console.log(`# deploy-local-kernel → ${TARGET} (arch=${ARCH}${SKIP_INSTALL ? ', skip-install' : ''})`)

// 0. 连通性
const targets = execSync('hdc list targets', { encoding: 'utf8' }).trim()
if (!targets.includes(TARGET)) {
  console.error(`FAIL: target ${TARGET} not connected (hdc list targets: ${targets.split('\n').join(', ')})`)
  process.exit(1)
}
console.log('✓ target connected')

// 1. 安装 hmh(推 install-kaihongos.cjs → 设备端 node 执行)
if (!SKIP_INSTALL) {
  if (!existsSync(INSTALLER)) {
    console.error(`FAIL: installer not found: ${INSTALLER}`)
    process.exit(1)
  }
  if (ARCH === 'arm') {
    const armTar = process.env.HMH_ARM_NODE
    if (!armTar || !existsSync(armTar)) {
      console.error('FAIL: --arch arm 需要 HMH_ARM_NODE=<node-tar-path>(arm 版 node 二进制)')
      process.exit(1)
    }
    send(armTar, '/data/local/tmp/node-arm.tar.gz')
  }
  console.log('— push installer…')
  console.log(send(INSTALLER, '/data/local/tmp/install-kaihongos.cjs'))
  console.log('— run installer on device (数分钟)…')
  const out = sh(`${DEV_NODE} /data/local/tmp/install-kaihongos.cjs`, 300000)
  console.log(String(out).slice(-1200))
  if (!ok(out)) { console.error('FAIL: installer errored'); process.exit(1) }
} else {
  console.log('— skip install (已装过)')
}

// 2. jitless 启动器补丁(本 VM 禁 RWX,V8 JIT 必崩;幂等)
console.log('— patch launchers (jitless)…')
const FIX = `const fs=require('fs');const files=['/data/local/home/.local/bin/hmh','/usr/local/bin/hmh','/system/bin/hmh'];let n=0;for(const f of files){try{let s=fs.readFileSync(f,'utf8');s=s.split('NODE_ALLOW_JIT="${NODE_ALLOW_JIT:-1}"').join('NODE_ALLOW_JIT="${NODE_ALLOW_JIT:-0}"');const re=/# drop --jitless[\\s\\S]*?&& export NODE_OPTIONS/;const rep='# kaihongos VM: root hdc shell also forbids RWX - default jitless\\nif [ -z "${NODE_ALLOW_JIT:-}" ] || [ "${NODE_ALLOW_JIT}" = "0" ]; then\\n  case " ${NODE_OPTIONS:-} " in\\n    *" --jitless "*|*" --jitless") ;;\\n    *) export NODE_OPTIONS="--jitless${NODE_OPTIONS:+ $NODE_OPTIONS}" ;;\\n  esac\\nfi\\n[ -n "${NODE_OPTIONS:-}" ] && export NODE_OPTIONS';if(re.test(s)){s=s.replace(re,rep);}fs.writeFileSync(f,s);n++;}catch(e){}}console.log('patched '+n);`
const fixTmp = join(mkdtempSync(join(tmpdir(), 'hmh-fix-')), 'fix.cjs')
writeFileSync(fixTmp, FIX)
send(fixTmp, '/data/local/tmp/fix-launcher.cjs')
console.log(sh(`${DEV_NODE} /data/local/tmp/fix-launcher.cjs`))

// 3. hmh 自检
console.log('— hmh check…')
const ver = sh(`echo /exit | ${HMH} 2>&1 | head -3`)
console.log(ver)
if (!ok(ver)) { console.error('FAIL: hmh not runnable'); process.exit(1) }

// 4. 推 config(token 走环境变量→设备文件,绝不进命令行/日志)
const token = process.env[TOKEN_ENV] ?? ''
if (token) {
  console.log(`— push config (token from ${TOKEN_ENV}, len=${token.length})…`)
  const cfgDir = mkdtempSync(join(tmpdir(), 'hmh-cfg-'))
  const cfgPath = join(cfgDir, 'config.json')
  writeFileSync(cfgPath, JSON.stringify({ web: { token } }, null, 2))
  send(cfgPath, '/data/local/home/.hmharness/config.json')
  console.log('✓ config pushed (token 内容不回显)')
} else {
  console.log(`— no ${TOKEN_ENV} env;保留设备现有 config(127.0.0.1 直连本就免 token)`)
}

// 5. 起 web(或只重启)
console.log('— start web (--exposure=lan, 0.0.0.0:7788)…')
sh(`${HMH} web stop 2>/dev/null`)
const startOut = sh(`rm -f /data/local/tmp/web.log ; ${HMH} web start --exposure=lan > /data/local/tmp/web.log 2>&1 &`)
execSync('ping -n 4 127.0.0.1 > nul')  // 等 3s
const log = sh('cat /data/local/tmp/web.log')
console.log(log.split('\n').slice(0, 6).join('\n'))
const listen = sh('netstat -tln 2>/dev/null | grep 7788')
console.log('listen: ' + listen)
if (!listen.includes('7788')) {
  console.error('FAIL: 7788 not listening — web.log:\n' + log)
  if (!RESTART_WEB) process.exit(1)
}

// 6. API 自检(设备侧探 /api/state)
console.log('— /api/state probe…')
const probe = `const http=require('http');http.get({host:'127.0.0.1',port:7788,path:'/api/state',timeout:5000},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);console.log('OK ver='+(j.daemonVersion||'?')+' model='+(j.model||'?')+' home='+(j.home||'?'))}catch(e){console.log('BAD '+d.slice(0,120))}})}).on('error',e=>console.log('ERR '+e.message))`
const probeTmp = join(mkdtempSync(join(tmpdir(), 'hmh-probe-')), 'p.cjs')
writeFileSync(probeTmp, probe)
send(probeTmp, '/data/local/tmp/probe-local.cjs')
console.log(sh(`${DEV_NODE} /data/local/tmp/probe-local.cjs`, 20000))

console.log(`
✅ 设备内核就绪。
   应用内:设置 → 服务器地址填 http://127.0.0.1:7788 (本机直连,免 token)
   或 PC 端直连: http://<设备IP>:7788 (token 见设备 config)
   三端同核: 应用 = TUI = 浏览器,共享 /data/local/home/.hmharness`)
