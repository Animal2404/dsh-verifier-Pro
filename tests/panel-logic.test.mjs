// GUI 逻辑回归（锐评「E2E/GUI 测试层未建」的补建）：
// 面板纯逻辑（extractPanel + derivePanelState）不依赖 React / 宿主 client 包，
// 可在 CI 无浏览器运行。覆盖状态矩阵：ok/degraded/flat/unstable/escalated/
// anomaly/literal-mc/VAL/plain。
// 注意：panelLogic.ts 被 tsdown 打进浏览器 bundle，node 无法直接 require——
// CI/本地先把它独立编译到 lib/client/panelLogic.js（harness-free）再测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPanel, derivePanelState, ACTION_LABELS } from '../lib/client/panelLogic.js'

const extract = extractPanel
const derive = derivePanelState

/** 构造一个标准 wire block（meta 通道，与宿主 presentationMeta 契约一致）。 */
const block = (data, extra = {}) => ({
  kind: 'tool-call',
  call: { argsRaw: JSON.stringify({ action: 'compare' }) },
  meta: { verifier: data },
  ...extra,
})

// 用 data.action 作为面板 action（真实面板：extract 从 meta/call args 提取 action）
const deriveOf = (data) => derive(extract('verifier', block(data)), data.action ?? 'compare')

test('ok：正常分数 → 徽章「正常」+ VAL L0', () => {
  const p = deriveOf({ action: 'compare', reward_a: 0.7, reward_b: 0.3, score_mode: 'logprobs' })
  assert.equal(p.stateKey, 'ok')
  assert.equal(p.badgeText, '正常')
  assert.equal(p.valLevel, 'L0')
  assert.equal(p.mcNote, null, 'logprobs 路径无采样提示')
})

test('literal-mc：采样近似分 → 徽章 ok + mcNote + VAL L0', () => {
  const p = deriveOf({ action: 'compare', reward_a: 0.5, reward_b: 0.9, score_mode: 'literal-mc', k_used: 5 })
  assert.equal(p.stateKey, 'ok')
  assert.match(p.mcNote ?? '', /采样近似分/, '必须标注采样近似')
  assert.match(p.mcNote ?? '', /5 次/, '必须标注 K 值')
})

test('degraded：全 0.5 → 「信号不可信」+ warn + VAL L1', () => {
  const p = deriveOf({ action: 'compare', reward_a: 0.5, reward_b: 0.5, signal: 'degraded', warning: '⚠️ 全部候选精确等于 0.5' })
  assert.equal(p.stateKey, 'degraded')
  assert.equal(p.badgeText, '信号不可信')
  assert.ok(p.isWarn)
  assert.equal(p.valLevel, 'L1', '规则护栏介入')
})

test('flat：无区分度 → 「无区分度」+ 建议 compare 复核', () => {
  const p = deriveOf({ action: 'select', index: 0, scores: [0.5, 0.5], signal: 'flat' })
  assert.equal(p.stateKey, 'flat')
  assert.equal(p.badgeText, '无区分度')
  assert.match(p.noticeText ?? '', /对比评审|compare/, '应建议复核')
})

test('unstable：信号不稳 → warn 徽章', () => {
  const p = deriveOf({ action: 'select', signal: 'unstable', index: 0, scores: [0.6, 0.4], initial: {}, escalated_result: {} })
  assert.equal(p.stateKey, 'unstable')
  assert.equal(p.badgeText, '信号不稳')
  assert.ok(p.isWarn)
})

test('escalated：分差小升级 → 徽章含已评次数', () => {
  const p = deriveOf({ action: 'compare', reward_a: 0.55, reward_b: 0.6, escalated: true, k_used: 3 })
  assert.equal(p.stateKey, 'escalated')
  assert.match(p.badgeText, /已评3次/)
})

test('anomaly：越界裁剪 → ok 态也必须显示警告 + VAL L1', () => {
  const p = deriveOf({ action: 'compare', reward_a: 0.3, reward_b: 0.8, anomaly: 'reward_out_of_range', warning: '⚠️ 评分返回越界值已被裁剪到 [0,1]' })
  assert.equal(p.stateKey, 'ok', '状态仍是正常')
  assert.ok(p.noticeText, '但必须有警告')
  assert.match(p.noticeText ?? '', /裁剪/, '警告指向裁剪')
  assert.equal(p.valLevel, 'L1', '规则介入')
})

test('plain：无数据 → 回退动作名徽章', () => {
  const p = derive(extract('verifier', null), 'select')
  assert.equal(p.stateKey, 'plain')
  assert.equal(p.badgeText, '择优评选')
})

test('extract：meta 通道优先于文本，异常 block 不抛', () => {
  assert.deepEqual(extract('verifier', null), { action: 'verifier', data: null, isError: false, running: false })
  const bad = extract('verifier', { kind: 'tool-call', content: ['not-json'] })
  assert.equal(bad.data, null)
  // 文本 JSON 回退
  const viaText = extract('verifier', { kind: 'tool-call', call: { argsRaw: '{"action":"compare"}' }, content: [{ type: 'text', text: '{"reward_a":0.9,"reward_b":0.1}' }] })
  assert.equal(viaText.data?.reward_a, 0.9)
})

test('decompose：结构化诊断显示摘要行（不再空白）', () => {
  const p = deriveOf({
    action: 'decompose',
    step_summary: [{ step: 1 }, { step: 2 }, { step: 3 }],
    potential_errors: [{ behavior: 'x', error: 'y' }],
    check_questions: [{ question: 'q1' }, { question: 'q2' }],
  })
  assert.equal(p.stateKey, 'ok')
  assert.ok(p.summaryLine, 'decompose 必须有摘要行')
  assert.match(p.summaryLine ?? '', /3 步/, '含步数')
  assert.match(p.summaryLine ?? '', /1 个/, '含可疑行为数')
  assert.match(p.summaryLine ?? '', /2 个/, '含核查问题数')
})

test('evaluate_session：评分导出显示 checkpoint/均分/趋势（不再空白）', () => {
  const p = deriveOf({
    action: 'evaluate_session',
    scores: [0.3, 0.6, 0.9],
    export: { checkpoints: [{ checkpoint: 1, score: 0.3 }, { checkpoint: 2, score: 0.6 }, { checkpoint: 3, score: 0.9 }], trend: 0.6, summary: 0.6 },
  })
  assert.equal(p.stateKey, 'ok')
  assert.ok(p.summaryLine, 'evaluate_session 必须有摘要行')
  assert.match(p.summaryLine ?? '', /3 个/, '含 checkpoint 数')
  assert.match(p.summaryLine ?? '', /0\.6/, '含均分')
  assert.match(p.summaryLine ?? '', /\+0\.6/, '含趋势')
})

// 非评分动作：task_start/progress_start/progress_close/usage/无结果的 task_status
// 不产生 LLM 判断——VAL 行应为 null（卡片不渲染「验证锚定: L0」）。
test('非评分动作：task_start/progress_start/progress_close/usage 无 VAL 标注', () => {
  const cases = [
    { action: 'task_start', task_id: 't1', status: 'running' },
    { action: 'progress_start', tracker_id: 'tr1' },
    { action: 'progress_close', closed: true },
    { action: 'usage', usage: { calls: 1, input_tokens: 10 } },
    { action: 'task_status', task_id: 't1', status: 'running' },
  ]
  for (const data of cases) {
    const p = deriveOf(data)
    assert.equal(p.valLevel, null, `${data.action} 不应有 VAL 等级`)
    assert.equal(p.valNote, null, `${data.action} 不应渲染 VAL 行`)
  }
})

test('评分动作：progress_update 与有结果的 task_status 保留 VAL L0', () => {
  const pu = deriveOf({ action: 'progress_update', score: 0.5 })
  assert.equal(pu.valLevel, 'L0', 'progress_update 有进度分 → L0')
  const ts = deriveOf({ action: 'task_status', task_id: 't1', status: 'done', scores: [0.6, 0.4], index: 0 })
  assert.equal(ts.valLevel, 'L0', 'task_status 带评分结果 → L0')
})

// 非评分动作也要显示实际内容（用户反馈：progress/task/usage 卡片空白）。
test('progress/task/usage 卡片显示内容摘要（不再空白）', () => {
  const pu = deriveOf({ action: 'progress_update', score: 0.406 })
  assert.match(pu.summaryLine ?? '', /进度分: 0\.406/, 'progress_update 显示进度分')
  const ps = deriveOf({ action: 'progress_start', tracker_id: 'tracker-1' })
  assert.match(ps.summaryLine ?? '', /tracker: tracker-1/, 'progress_start 显示 tracker id')
  const pc = deriveOf({ action: 'progress_close', closed: true })
  assert.match(pc.summaryLine ?? '', /已关闭/, 'progress_close 显示关闭确认')
  const tstart = deriveOf({ action: 'task_start', task_id: 't9', status: 'running' })
  assert.match(tstart.summaryLine ?? '', /任务 t9 已提交/, 'task_start 显示任务提交')
  const tdone = deriveOf({ action: 'task_status', task_id: 't9', status: 'done', result: { index: 1, scores: [0.3, 0.7] } })
  assert.match(tdone.summaryLine ?? '', /任务完成/, 'task_status done 显示完成')
  assert.match(tdone.summaryLine ?? '', /冠军 B/, 'task_status 显示冠军字母')
  const trun = deriveOf({ action: 'task_status', task_id: 't9', status: 'running' })
  assert.match(trun.summaryLine ?? '', /running/, 'task_status running 显示运行中')
  const u = deriveOf({ action: 'usage', usage: { calls: 62, input_tokens: 27827, output_tokens: 17341, cache_hit_rate: 0.564 } })
  assert.match(u.summaryLine ?? '', /62 次调用/, 'usage 显示调用次数')
  assert.match(u.summaryLine ?? '', /27\.8K in/, 'usage 显示输入 token')
  assert.match(u.summaryLine ?? '', /56%/, 'usage 显示缓存命中率')
})

// 卡片标题必须是中文（用户反馈：全部卡片都要让用户知道是干什么的）。
test('ACTION_LABELS 覆盖全部 action（卡片中文标题）', () => {
  const expected = {
    select: '择优评选', compare: '对比评审', track: '轨迹打分',
    decompose: '分解验证', evaluate_session: '会话评估',
    progress_start: '进度追踪 · 开始', progress_update: '进度追踪 · 更新',
    progress_close: '进度追踪 · 结束', task_start: '异步任务 · 启动',
    task_status: '异步任务 · 查询', usage: '用量统计',
  }
  for (const [action, label] of Object.entries(expected)) {
    assert.equal(ACTION_LABELS[action], label, `${action} 的中文标题`)
  }
  // 标题用于渲染：`🔍 {label} · {action}`
  const titleOf = (a) => `🔍 ${ACTION_LABELS[a] ?? a} · ${a}`
  assert.equal(titleOf('progress_update'), '🔍 进度追踪 · 更新 · progress_update')
  assert.equal(titleOf('task_status'), '🔍 异步任务 · 查询 · task_status')
  assert.equal(titleOf('usage'), '🔍 用量统计 · usage')
})
