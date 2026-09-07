import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { materializePlugin, parsePluginSpec, parsePluginsInput } from '../scripts/lib/plugins.mjs'

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
    ['@npm-scope/plugin@version', { kind: 'npm', name: '@npm-scope/plugin@version', packageName: '@npm-scope/plugin' }],
    ['@npm-scope/plugin', { kind: 'npm', name: '@npm-scope/plugin', packageName: '@npm-scope/plugin' }],
    ['bare-name@1.2.3', { kind: 'npm', name: 'bare-name@1.2.3', packageName: 'bare-name' }],
    ['bare-name', { kind: 'npm', name: 'bare-name', packageName: 'bare-name' }],
    ['path/to/plugin', { kind: 'path', path: 'path/to/plugin' }],
    ['path/to/plugin.tgz', { kind: 'path', path: 'path/to/plugin.tgz' }],
    ['path:path/to/plugin', { kind: 'path', path: 'path/to/plugin' }],
    ['path:path/to/plugin.tgz', { kind: 'path', path: 'path/to/plugin.tgz' }],
    ['./plugins/foo', { kind: 'path', path: './plugins/foo' }],
    ['plugins\\foo', { kind: 'path', path: 'plugins\\foo' }],
    ['C:/abs/plugin.tgz', { kind: 'path', path: 'C:/abs/plugin.tgz' }],
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

describe('materializePlugin path 形态', () => {
  it('目录打包为 tgz 并带回包名', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-plt-path-'))
    const workDir = await mkdtemp(join(tmpdir(), 'dsh-plt-work-'))
    await writeFile(join(dir, 'package.json'),
      JSON.stringify({ name: '@demo/path-plugin', version: '0.0.1' }), 'utf8')
    const { target, packageName } = await materializePlugin(
      parsePluginSpec(`path:${dir}`), { workDir, log: () => {} })
    assert.equal(packageName, '@demo/path-plugin')
    assert.match(target, /path-plugin-0\.0\.1\.tgz$/u)
    assert.ok(existsSync(target))
  })

  it('tgz 直通，不存在则报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-plt-tgz-'))
    const tgz = join(dir, 'demo-1.0.0.tgz')
    await writeFile(tgz, 'fake', 'utf8')
    const { target } = await materializePlugin(parsePluginSpec(tgz), { workDir: dir, log: () => {} })
    assert.equal(target, resolve(tgz))
    await assert.rejects(
      materializePlugin(parsePluginSpec(join(dir, 'missing.tgz')), { workDir: dir, log: () => {} }),
      /不存在/u)
  })

  it('目录缺少 package.json 报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-plt-empty-'))
    await assert.rejects(
      materializePlugin(parsePluginSpec(`path:${dir}`), { workDir: dir, log: () => {} }),
      /缺少 package\.json/u)
  })
})
