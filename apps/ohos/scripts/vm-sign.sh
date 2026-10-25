#!/bin/sh
# 重签 api23 版
set -e
SIG=/data/local/home/.ohos/signature
TMP=/data/local/tmp/hmhsign
hap-sign-tool sign-app -keyAlias "OpenHarmony Application Release" \
  -signAlg SHA256withECDSA -mode localSign \
  -appCertFile $SIG/OpenHarmonyApplication.pem \
  -profileFile $TMP/hmh-profile.p7b \
  -inFile /data/local/tmp/entry-api23-unsigned.hap \
  -keystoreFile $SIG/OpenHarmony.p12 -keystorePwd 123456 -keyPwd 123456 \
  -outFile /data/local/tmp/hmh-api23-signed.hap
echo "=== SIGNED api23 ==="
bm install -p /data/local/tmp/hmh-api23-signed.hap
