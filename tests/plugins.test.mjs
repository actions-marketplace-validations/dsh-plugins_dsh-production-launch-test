import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePluginSpec, parsePluginsInput } from '../scripts/lib/plugins.mjs'

describe('parsePluginSpec', () => {
  const cases = [
    ['artifact:plugin-build-artifact', { kind: 'artifact', name: 'plugin-build-artifact' }],
    ['github:user/repo', { kind: 'github', owner: 'user', repo: 'repo' }],
    ['github:user/repo#commit=1234abc', { kind: 'github', owner: 'user', repo: 'repo', commit: '1234abc' }],
    ['github:user/repo@release-tag', { kind: 'github', owner: 'user', repo: 'repo', tag: 'release-tag' }],
    ['github:user/repo#path/to/plugin', { kind: 'github', owner: 'user', repo: 'repo', path: 'path/to/plugin' }],
    ['github:user/repo#path/to/plugin&commit=1234abc',
      { kind: 'github', owner: 'user', repo: 'repo', path: 'path/to/plugin', commit: '1234abc' }],
    ['github:user/repo#path/to/plugin@release-tag',
      { kind: 'github', owner: 'user', repo: 'repo', path: 'path/to/plugin', tag: 'release-tag' }],
    ['github:user/repo#path/to/plugin.tgz',
      { kind: 'github', owner: 'user', repo: 'repo', path: 'path/to/plugin.tgz' }],
    ['github:user/repo#path/to/plugin.tgz&commit=1234abc',
      { kind: 'github', owner: 'user', repo: 'repo', path: 'path/to/plugin.tgz', commit: '1234abc' }],
    ['github:user/repo#path/to/plugin.tgz@release-tag',
      { kind: 'github', owner: 'user', repo: 'repo', path: 'path/to/plugin.tgz', tag: 'release-tag' }],
    ['@npm-scope/plugin@version', { kind: 'npm', name: '@npm-scope/plugin@version' }],
    ['@npm-scope/plugin', { kind: 'npm', name: '@npm-scope/plugin' }],
    ['bare-name@1.2.3', { kind: 'npm', name: 'bare-name@1.2.3' }],
    ['bare-name', { kind: 'npm', name: 'bare-name' }],
  ]
  for (const [input, expected] of cases) {
    it(`解析 ${input}`, () => {
      const spec = parsePluginSpec(input)
      assert.deepEqual({ ...spec, raw: undefined }, { ...expected, raw: undefined })
      assert.equal(spec.raw, input)
    })
  }

  const invalid = [
    'artifact:',
    'github:user/repo#',
    'github:user/repo#commit=',
    'github:user/repo@',
    'github:onlyname',
    'ftp://example.com/x',
    '',
  ]
  for (const input of invalid) {
    it(`拒绝 ${JSON.stringify(input)}`, () => {
      assert.throws(() => parsePluginSpec(input))
    })
  }
})

describe('parsePluginsInput', () => {
  it('忽略空行与注释，逐行解析', () => {
    const specs = parsePluginsInput(`
# 注释行
github:user/repo

@scope/plugin@1.0.0
`)
    assert.equal(specs.length, 2)
    assert.equal(specs[0].kind, 'github')
    assert.equal(specs[1].kind, 'npm')
  })

  it('空输入返回空数组', () => {
    assert.deepEqual(parsePluginsInput(''), [])
    assert.deepEqual(parsePluginsInput(undefined), [])
  })
})
