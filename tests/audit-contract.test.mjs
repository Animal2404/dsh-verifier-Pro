// vselftest 审计的根因是"约定在进程间复制粘贴"——本文件把最容易静默分叉的
// 三处契约用测试钉死：任一实现漂移，CI 立即红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const smokeSrc = readFileSync(join(ROOT, 'scripts', 'smoke.mjs'), 'utf8')
const buildEvidenceSrc = readFileSync(join(ROOT, 'scripts', 'build_evidence.mjs'), 'utf8')
const bestofnSrc = readFileSync(join(ROOT, 'src', 'bestofn.ts'), 'utf8')

test('契约①: artifactName 的哈希宽度与 resolve 基准两侧一致（身份链根基）', () => {
  for (const [name, src] of [['smoke.mjs', smokeSrc], ['build_evidence.mjs', buildEvidenceSrc]]) {
    assert.ok(src.includes('shortHash'), `${name} 必须定义 shortHash`)
    assert.match(src, /shortHash\(resolve\(/, `${name} 的哈希必须基于 resolve() 绝对路径`)
    assert.ok(src.includes(".slice(0, 8)"), `${name} 哈希宽度必须 = 8（两侧不一致即身份分叉）`)
    assert.doesNotMatch(src, /process\.chdir/, `${name} 不得 chdir（破坏共享 CWD 身份契约）`)
  }
})

test('契约②: stem 规则两侧一致（剥最后一个扩展名）', () => {
  // 源码字面量：basename(x).replace(/\.[^.]+$/, '')
  const stemRule = ".replace(/\\.[^.]+$/, '')"
  assert.ok(smokeSrc.includes(stemRule), 'smoke.mjs 缺少标准 stem 规则')
  assert.ok(buildEvidenceSrc.includes(stemRule), 'build_evidence.mjs 缺少标准 stem 规则')
})

test('契约③: crossCheckClaimEvidence 的段落标题锚点与 build_evidence 输出一致', () => {
  // 标题漂移会让声明-证据核对静默退化为 "uncheckable → 全部一致"。
  for (const header of ['## 功能摘要（候选自述）', '## 运行时观察（冒烟测试，非候选自述）']) {
    assert.ok(buildEvidenceSrc.includes(header), `build_evidence 缺少段落标题: ${header}`)
    assert.ok(bestofnSrc.includes(header), `bestofn 交叉核对正则未覆盖标题: ${header}`)
  }
})

test('契约④: ERR_COLLECTOR 浏览器侧幂等守卫存在（防跨运行 k× 错误膨胀）', () => {
  assert.match(smokeSrc, /__errCollectorInstalled/, '采集器源码必须自带安装守卫')
})
