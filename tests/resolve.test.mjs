import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tgzToPackageName } from '../scripts/lib/dsh-source.mjs'
import { mergeDshVersions, pickPluginVersion } from '../scripts/lib/resolve.mjs'
import { compareSemver, parseSemver, sortSemver } from '../scripts/lib/semver.mjs'

describe('semver', () => {
  it('解析核心段与预发布', () => {
    assert.deepEqual(parseSemver('0.1.2-alpha.5'),
      { major: 0, minor: 1, patch: 2, pre: ['alpha', '5'] })
    assert.deepEqual(parseSemver('1.3.4'), { major: 1, minor: 3, patch: 4, pre: [] })
    assert.equal(parseSemver('not-a-version'), null)
  })

  it('比较：正式版 > 预发布，alpha < rc', () => {
    assert.equal(compareSemver('0.1.2-rc.1', '0.1.2-alpha.5'), 1)
    assert.equal(compareSemver('0.1.0-rc.6', '0.1.0-rc.7'), -1)
    assert.equal(compareSemver('1.3.4', '1.3.4-dev.33725077373'), 1)
    assert.equal(compareSemver('0.14.4', '0.15.0-dev.34052887197'), -1)
    assert.equal(compareSemver('0.1.3-alpha.1', '0.1.2-rc.1'), 1)
    assert.equal(compareSemver('0.1.2', '0.1.2'), 0)
  })

  it('排序', () => {
    assert.deepEqual(sortSemver(['0.1.2-rc.1', '0.1.0-rc.6', '0.1.2-alpha.1']),
      ['0.1.0-rc.6', '0.1.2-alpha.1', '0.1.2-rc.1'])
  })
})

describe('mergeDshVersions', () => {
  it('合并 npm 与 GitHub Releases，过滤下限并升序', () => {
    const npm = ['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2',
      '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5', '0.1.2-rc.1']
    const tags = ['dsh-v0.1.0-rc.6', 'dsh-v0.1.2-alpha.1', 'dsh-v0.1.3-alpha.1', 'dsh-v0.1.2-rc.1']
    assert.deepEqual(mergeDshVersions(npm, tags, '0.1.0-rc.6'), [
      '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2',
      '0.1.2-alpha.1', '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4',
      '0.1.2-alpha.5', '0.1.2-rc.1', '0.1.3-alpha.1',
    ])
  })

  it('低于下限的版本被过滤', () => {
    assert.deepEqual(mergeDshVersions(['0.0.1-rc.1', '0.1.0-rc.6'], [], '0.1.0-rc.6'), ['0.1.0-rc.6'])
  })

  it('非 dsh-v 前缀 tag 与非法版本忽略', () => {
    assert.deepEqual(
      mergeDshVersions([], ['launcher-v1.0.0', 'dsh-vx.y.z', 'dsh-v0.1.3-alpha.1'], '0.1.0-rc.6'),
      ['0.1.3-alpha.1'])
  })
})

describe('pickPluginVersion', () => {
  it('latest 更新时取 latest', () => {
    assert.equal(pickPluginVersion({ latest: '0.3.3', next: '0.3.3-dev.33725077373' }), '0.3.3')
  })
  it('next 更新时取 next', () => {
    assert.equal(pickPluginVersion({ latest: '0.14.4', next: '0.15.0-dev.34052887197' }), '0.15.0-dev.34052887197')
  })
  it('一侧缺失回退', () => {
    assert.equal(pickPluginVersion({ latest: '1.0.0' }), '1.0.0')
    assert.throws(() => pickPluginVersion({}))
  })
})

describe('tgzToPackageName', () => {
  it('release:pack 产物名映射', () => {
    assert.equal(tgzToPackageName('deepseek-ai-dsh-0.1.2-alpha.1.tgz'), '@deepseek-ai/dsh')
    assert.equal(tgzToPackageName('deepseek-ai-dsh-webhook-0.1.3-alpha.1.tgz'), '@deepseek-ai/dsh-webhook')
    assert.equal(tgzToPackageName('deepseek-ai-dsh-client-ui-chat-0.1.2-rc.1.tgz'), '@deepseek-ai/dsh-client-ui-chat')
  })
  it('无法解析返回 null', () => {
    assert.equal(tgzToPackageName('random-file.tgz'), null)
    assert.equal(tgzToPackageName('deepseek-ai-dsh.tgz'), null)
  })
})
