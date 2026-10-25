import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBaseUrl } from './url-norm'

test('normalize: 纯数字+全角标点(IME 实况) 被规范化为合法 URL', () => {
  // IME 实测输出形如 "192。168。161。1：7788"
  assert.equal(normalizeBaseUrl('192。168。161。1：7788'), 'http://192.168.161.1:7788')
})

test('normalize: 半角原样+自动补 scheme', () => {
  assert.equal(normalizeBaseUrl('192.168.161.1:7788'), 'http://192.168.161.1:7788')
})

test('normalize: 已带 http:// 不动', () => {
  assert.equal(normalizeBaseUrl('http://192.168.161.1:7788'), 'http://192.168.161.1:7788')
})

test('normalize: 已带 https:// 不动', () => {
  assert.equal(normalizeBaseUrl('https://example.com:9000'), 'https://example.com:9000')
})

test('normalize: 尾空格 trim', () => {
  assert.equal(normalizeBaseUrl('  192.168.161.1:7788  '), 'http://192.168.161.1:7788')
})

test('normalize: 空串透传', () => {
  assert.equal(normalizeBaseUrl(''), '')
  assert.equal(normalizeBaseUrl('   '), '')
})

test('normalize: 全角斜杠与混合', () => {
  assert.equal(normalizeBaseUrl('192。168。161。1：7788／'), 'http://192.168.161.1:7788/')
})
