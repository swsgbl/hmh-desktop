import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, pickLocale, dictKeysMatch } from './i18n-dict.ts';

test('zh/en 字典键集一致(蓝本 typeof zh 锁形的运行时版)', () => {
  assert.ok(dictKeysMatch(), 'zh/en 键集不一致——补齐缺词条');
});

test('取词:zh 命中/en 命中/缺失回退 key', () => {
  assert.equal(t('comp.send', 'zh'), '发送');
  assert.equal(t('comp.send', 'en'), 'Send');
  assert.equal(t('__nope__', 'zh'), '__nope__');
});

test('系统语言映射:zh* → zh,其余 en', () => {
  assert.equal(pickLocale('zh-CN'), 'zh');
  assert.equal(pickLocale('ZH_HANT'), 'zh');
  assert.equal(pickLocale('en-US'), 'en');
  assert.equal(pickLocale(''), 'en');
});

test('关键 UI 词条与蓝本 1:1(抽查)', () => {
  // 蓝本 i18n.ts 原文抽查
  assert.equal(t('stream.turnSumSample', 'zh'), 'stream.turnSumSample'); // 缺失键回退(占位自检)
  assert.equal(t('side.loadMore', 'zh'), '加载更多');
  assert.equal(t('dock.logsHead', 'en'), 'Run logs (runtime line stream, last 200)');
});
