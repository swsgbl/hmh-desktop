// P0.1 one-click deploy: build -> patch api23 -> send -> VM sign -> install -> launch (no token)
// usage: node apps/ohos/scripts/deploy.mjs [--skip-build]
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // G:/hmh-desktop
const OHOS = join(ROOT, 'apps', 'ohos');
const TMP = join(ROOT, '.hm-tmp');
const TARGET = process.env.HMH_HDC_TARGET || '192.168.161.137:10178';
const BUNDLE = 'com.hmh.desktop.ohos';
const HAP_UNSIGNED = join(OHOS, 'entry', 'build', 'default', 'outputs', 'default', 'entry-default-unsigned.hap');
const HAP_V23 = join(TMP, 'entry-api23-deploy.hap');

function run(cmd, opts) {
  console.log('$', cmd.replace(/x-hmh-key[^\s"]*/g, 'x-hmh-key[REDACTED]').slice(0, 120));
  return execSync(cmd, { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024, ...opts });
}

// 0. self-contained helpers: scripts/patch-api23.cjs + scripts/vm-sign.sh (durable home)
const PATCH_DST = join(OHOS, 'scripts', 'patch-api23.cjs');
const SIGN_DST = join(OHOS, 'scripts', 'vm-sign.sh');
const PATCH_SRC = join(TMP, 'hm-patch-hap23.cjs');
const SIGN_SRC = join(TMP, 'vm-sign23.sh');
mkdirSync(join(OHOS, 'scripts'), { recursive: true });
if (!existsSync(PATCH_DST) && existsSync(PATCH_SRC)) copyFileSync(PATCH_SRC, PATCH_DST);
if (!existsSync(SIGN_DST)) {
  // durable VM-side sign script (profile p7b already generated at /data/local/tmp/hmhsign/)
  const SIGN_SH = ['#!/bin/sh',
    'set -e',
    'SIG=/data/local/home/.ohos/signature',
    'TMP=/data/local/tmp/hmhsign',
    'mkdir -p $TMP',
    'hap-sign-tool sign-app -keyAlias "OpenHarmony Application Release" \\',
    '  -signAlg SHA256withECDSA -mode localSign \\',
    '  -appCertFile $SIG/OpenHarmonyApplication.pem \\',
    '  -profileFile $TMP/hmh-profile.p7b \\',
    '  -inFile /data/local/tmp/entry-api23-unsigned.hap \\',
    '  -keystoreFile $SIG/OpenHarmony.p12 -keystorePwd 123456 -keyPwd 123456 \\',
    '  -outFile /data/local/tmp/hmh-api23-signed.hap',
    'bm install -p /data/local/tmp/hmh-api23-signed.hap'].join('\n');
  writeFileSync(SIGN_DST, SIGN_SH);
  if (existsSync(SIGN_SRC)) copyFileSync(SIGN_SRC, SIGN_DST); // keep proven one if present
}
run(`hdc -t ${TARGET} file send "${SIGN_DST}" /data/local/tmp/vm-sign23.sh`);

// 1. build
if (!process.argv.includes('--skip-build')) {
  const out = run(`cmd /c "cd /d "${OHOS}" && hvigorw.bat assembleHap --mode module -p product=default -p buildMode=debug --no-daemon 2>&1"`).toString();
  if (!/BUILD SUCCESSFUL/.test(out)) { console.error('BUILD FAILED:\n' + out.split('\n').filter(l => /ERROR/.test(l)).join('\n')); process.exit(1); }
  console.log('build OK');
} else console.log('build skipped');

// 2. patch api23
run(`node "${PATCH_DST}" "${HAP_UNSIGNED}" "${HAP_V23}"`);

// 3. send + sign + install (VM-side chain; token never involved)
run(`hdc -t ${TARGET} file send "${HAP_V23}" /data/local/tmp/entry-api23-unsigned.hap`);
console.log(run(`hdc -t ${TARGET} shell "sh /data/local/tmp/vm-sign23.sh"`).toString().trim());

// 4. launch
run(`hdc -t ${TARGET} shell "aa start -a EntryAbility -b ${BUNDLE}"`);
console.log('DEPLOY DONE ->', BUNDLE);
