import test from 'node:test'
import assert from 'node:assert/strict'
import { reduceProbe, bannerKey, shouldShowWizard, WIZARD_OPTIONS } from './first-run.ts'

test('reduceProbe: 已有配置 → keep(不打扰,走自动重连)', () => {
  assert.equal(reduceProbe({ localStateOk: true, hmhInstalled: true, hasConfig: true }), 'keep')
  assert.equal(reduceProbe({ localStateOk: false, hmhInstalled: false, hasConfig: true }), 'keep')
})

test('reduceProbe: 本机 7788 在线且无配置 → local-share(默认连本地共享)', () => {
  assert.equal(reduceProbe({ localStateOk: true, hmhInstalled: true, hasConfig: false }), 'local-share')
  assert.equal(reduceProbe({ localStateOk: true, hmhInstalled: false, hasConfig: false }), 'local-share')
})

test('reduceProbe: 无服务但 hmh 已装 → local-guide(启动指引)', () => {
  assert.equal(reduceProbe({ localStateOk: false, hmhInstalled: true, hasConfig: false }), 'local-guide')
})

test('reduceProbe: 都无 → wizard(安装向导)', () => {
  assert.equal(reduceProbe({ localStateOk: false, hmhInstalled: false, hasConfig: false }), 'wizard')
})

test('bannerKey: 仅 local-share 显示横幅', () => {
  assert.equal(bannerKey('local-share'), 'wizard.bannerLocal')
  assert.equal(bannerKey('keep'), null)
  assert.equal(bannerKey('wizard'), null)
  assert.equal(bannerKey('local-guide'), null)
})

test('shouldShowWizard: done/有配置 不再弹;local-guide 也走向导(给启动指引)', () => {
  assert.equal(shouldShowWizard(true, false, 'wizard'), false)
  assert.equal(shouldShowWizard(false, true, 'wizard'), false)
  assert.equal(shouldShowWizard(false, false, 'wizard'), true)
  assert.equal(shouldShowWizard(false, false, 'local-guide'), true)
  assert.equal(shouldShowWizard(false, false, 'local-share'), false)
  assert.equal(shouldShowWizard(false, false, 'keep'), false)
})

test('WIZARD_OPTIONS: 三选一,local-install 为首位(推荐默认)', () => {
  assert.deepEqual([...WIZARD_OPTIONS], ['local-install', 'remote', 'demo'])
})
