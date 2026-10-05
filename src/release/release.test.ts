import { releaseApi } from '../api/releaseApi'
import { computeBasisHashes, computeCompleteness, type ReleaseBatch } from './basis'

// 构造一批“依据不齐”的初始数据（P2/P7 出血不足、无通过样张），验证待复核
const pages = [
  { pageNo: 1, name: '封面', width: 210, height: 297, bleed: 3, content: '' },
  { pageNo: 2, name: '版权页', width: 210, height: 297, bleed: 2, content: '' },
  { pageNo: 7, name: '创作团队', width: 210, height: 297, bleed: 1, content: '' },
]
const positions = [
  { id: 'P-01', pageNo: 1, x: 34, y: 44, rotation: 0, front: true },
  { id: 'P-02', pageNo: 2, x: 372, y: 44, rotation: 0, front: true },
  { id: 'P-07', pageNo: 7, x: 34, y: 44, rotation: 0, front: false },
]
const sheet = { width: 720, height: 1020, bleed: 3, safe: 5, gutter: 6, binding: '骑马订', grain: '纵向' }
const proofs = [
  { id: 'PRF-01', round: 1, date: '2026-09-18', sample: '数字样张 v1', deltaE: 3.8, feedback: '', correction: '', owner: '周默', decision: '退回' as const },
]

const basis = computeBasisHashes(pages, positions, sheet, proofs)
const completeness = computeCompleteness(pages, positions, sheet, proofs)

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name} ${extra}`) }
}

function errCode(e: unknown): string {
  return (e as { response?: { status?: number; data?: { code?: string } } })?.response?.data?.code ?? 'UNKNOWN'
}
function errStatus(e: unknown): number {
  return (e as { response?: { status?: number } })?.response?.status ?? 0
}

async function main() {
  console.log('— 放行批次规则验证 —')

  // 1. 发起批次：依据不齐 → 拼版/色彩待复核
  const init = await releaseApi.initiate({
    frozen: { revision: 'R6', frozenAt: new Date().toISOString(), ...basis, sheet, pageCount: 3, positionCount: 3, proofCount: 1 },
    revision: 'R6',
    completeness,
  })
  const batch: ReleaseBatch = init.data.batch
  check('发起批次成功', !!batch)
  check('初始版本 v1', batch.version === 1)
  check('拼版签核待复核（出血不足）', batch.signoffs[0].status === '待复核', `status=${batch.signoffs[0].status}`)
  check('色彩签核待复核（无通过样张）', batch.signoffs[1].status === '待复核', `status=${batch.signoffs[1].status}`)
  check('整批待复核', batch.status === '待复核', `status=${batch.status}`)

  // 2. 越权签核：色彩管理签拼版 → 403 拒绝
  try {
    await releaseApi.sign(batch.id, { step: '拼版', role: '色彩管理', signer: '周默', expectedVersion: 1, basis, completeness })
    check('越权签核被拒绝', false)
  } catch (e) {
    check('越权签核返回 403', errStatus(e) === 403, `status=${errStatus(e)}`)
    check('越权签核 code=ROLE_FORBIDDEN', errCode(e) === 'ROLE_FORBIDDEN', `code=${errCode(e)}`)
  }

  // 3. 补齐依据（出血改为 3、样张通过）后失效重算 → 待签核
  const fixedPages = pages.map((p) => ({ ...p, bleed: 3 }))
  const fixedProofs = [{ ...proofs[0], decision: '通过' as const, deltaE: 1.8 }]
  const basis2 = computeBasisHashes(fixedPages, positions, sheet, fixedProofs)
  const completeness2 = computeCompleteness(fixedPages, positions, sheet, fixedProofs)
  const inv = await releaseApi.invalidate(batch.id, basis2, completeness2)
  check('失效后拼版转为待签核', inv.data.batch.signoffs[0].status === '待签核', `status=${inv.data.batch.signoffs[0].status}`)
  check('失效后色彩转为待签核', inv.data.batch.signoffs[1].status === '待签核', `status=${inv.data.batch.signoffs[1].status}`)
  check('失效后版本自增', inv.data.batch.version === 2, `version=${inv.data.batch.version}`)

  // 4. 拼版员签拼版 → 成功
  const s1 = await releaseApi.sign(inv.data.batch.id, { step: '拼版', role: '拼版员', signer: '林青', expectedVersion: 2, basis: basis2, completeness: completeness2 })
  check('拼版签核成功', s1.data.batch.signoffs[0].status === '已签核')
  check('签核人记录', s1.data.batch.signoffs[0].signer === '林青')
  check('版本自增到 v3', s1.data.batch.version === 3, `version=${s1.data.batch.version}`)

  // 5. 模拟另一终端抢先签色彩 → 先到者占用
  const conflict = await releaseApi.conflict(s1.data.batch.id, '色彩')
  check('另一终端签色彩成功', conflict.data.batch.signoffs[1].status === '已签核')
  check('占用者为另一终端', (conflict.data.batch.signoffs[1].signer ?? '').includes('另一终端'))
  check('版本自增到 v4', conflict.data.batch.version === 4, `version=${conflict.data.batch.version}`)

  // 6. 本终端用旧版本号签色彩 → 409 版本冲突
  try {
    await releaseApi.sign(s1.data.batch.id, { step: '色彩', role: '色彩管理', signer: '周默', expectedVersion: 3, basis: basis2, completeness: completeness2 })
    check('旧版本签核遇冲突', false)
  } catch (e) {
    check('返回 409', errStatus(e) === 409, `status=${errStatus(e)}`)
    check('code=VERSION_CONFLICT', errCode(e) === 'VERSION_CONFLICT', `code=${errCode(e)}`)
  }

  // 7. 写盘失败：签放行时注入失败 → 500，且无半批记录
  await releaseApi.setFailNextCommit(true)
  try {
    await releaseApi.sign(s1.data.batch.id, { step: '放行', role: '生产主管', signer: '顾珩', expectedVersion: 4, basis: basis2, completeness: completeness2 })
    check('写盘失败被拒绝', false)
  } catch (e) {
    check('写盘失败返回 500', errStatus(e) === 500, `status=${errStatus(e)}`)
    check('code=WRITE_FAILED', errCode(e) === 'WRITE_FAILED', `code=${errCode(e)}`)
  }
  // 恢复：批次仍停留在 v4（色彩已签、放行未签），无半批记录
  const afterFail = await releaseApi.current()
  check('失败后无半批记录（放行仍未签核）', afterFail.data.batch?.signoffs[2].status !== '已签核', `status=${afterFail.data.batch?.signoffs[2].status}`)
  check('失败后版本仍为 v4', afterFail.data.batch?.version === 4, `version=${afterFail.data.batch?.version}`)

  // 8. 重试恢复
  const retry = await releaseApi.retry(s1.data.batch.id)
  check('恢复到最后完整签核 v4', retry.data.recoveredTo === 4, `recoveredTo=${retry.data.recoveredTo}`)

  // 9. 正常签放行 → 整批放行
  const rel = await releaseApi.sign(retry.data.batch.id, { step: '放行', role: '生产主管', signer: '顾珩', expectedVersion: 4, basis: basis2, completeness: completeness2 })
  check('放行签核成功', rel.data.batch.signoffs[2].status === '已签核')
  check('整批已放行', rel.data.batch.status === '已放行', `status=${rel.data.batch.status}`)
  check('记录放行时间', !!rel.data.batch.releasedAt)

  // 10. 放行后再签 → 拒绝
  try {
    await releaseApi.sign(rel.data.batch.id, { step: '拼版', role: '拼版员', signer: '林青', expectedVersion: 5, basis: basis2, completeness: completeness2 })
    check('放行后重复签核被拒绝', false)
  } catch (e) {
    check('放行后签核返回 409', errStatus(e) === 409, `status=${errStatus(e)}`)
  }
}

async function invalidationCase() {
  console.log('\n— 依据变更失效验证 —')
  releaseApi.__reset()
  const pages = [
    { pageNo: 1, name: '封面', width: 210, height: 297, bleed: 3, content: '' },
    { pageNo: 2, name: '版权页', width: 210, height: 297, bleed: 3, content: '' },
  ]
  const positions = [
    { id: 'P-01', pageNo: 1, x: 34, y: 44, rotation: 0, front: true },
    { id: 'P-02', pageNo: 2, x: 372, y: 44, rotation: 0, front: true },
  ]
  const sheet = { width: 720, height: 1020, bleed: 3, safe: 5, gutter: 6, binding: '骑马订', grain: '纵向' }
  const proofs = [
    { id: 'PRF-01', round: 1, date: '2026-09-18', sample: '数字样张 v1', deltaE: 1.8, feedback: '', correction: '', owner: '周默', decision: '通过' as const },
  ]
  const basis = computeBasisHashes(pages, positions, sheet, proofs)
  const completeness = computeCompleteness(pages, positions, sheet, proofs)

  const init = await releaseApi.initiate({
    frozen: { revision: 'R6', frozenAt: new Date().toISOString(), ...basis, sheet, pageCount: 2, positionCount: 2, proofCount: 1 },
    revision: 'R6', completeness,
  })
  let b = init.data.batch
  // 拼版员签拼版
  const s = await releaseApi.sign(b.id, { step: '拼版', role: '拼版员', signer: '林青', expectedVersion: b.version, basis, completeness })
  check('拼版已签核', s.data.batch.signoffs[0].status === '已签核')

  // 改动版位（P1 位移）→ 新依据
  const moved = positions.map((p) => (p.pageNo === 1 ? { ...p, x: 52 } : p))
  const basis2 = computeBasisHashes(pages, moved, sheet, proofs)
  const completeness2 = computeCompleteness(pages, moved, sheet, proofs)
  const inv = await releaseApi.invalidate(b.id, basis2, completeness2)
  check('依据变更后拼版签核失效', inv.data.batch.signoffs[0].status === '已失效', `status=${inv.data.batch.signoffs[0].status}`)
  check('整批失效', inv.data.batch.status === '已失效', `status=${inv.data.batch.status}`)
  check('失效后需重新签核（可签）', inv.data.batch.signoffs[0].status === '已失效')

  // 改动打样决定（通过→退回）→ 色彩依据变
  const proofs2 = [{ ...proofs[0], decision: '退回' as const, deltaE: 3.2 }]
  const basis3 = computeBasisHashes(pages, moved, sheet, proofs2)
  const completeness3 = computeCompleteness(pages, moved, sheet, proofs2)
  const inv2 = await releaseApi.invalidate(b.id, basis3, completeness3)
  check('色彩依据变更后整批仍失效', inv2.data.batch.status === '已失效')
}

async function run() {
  await main()
  await invalidationCase()
  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) process.exit(1)
}

run().catch((e) => { console.error(e); process.exit(1) })
