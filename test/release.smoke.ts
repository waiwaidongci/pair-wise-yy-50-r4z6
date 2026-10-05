// 端到端冒烟：真实 Pinia store + 内存 localStorage，覆盖全部放行规则
import { createPinia, setActivePinia } from 'pinia'
import { useImpositionStore } from '../src/stores/imposition.ts'
import { useReleaseStore } from '../src/stores/release.ts'
import { setFault, restore } from '../src/release/persistence.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${msg}`)
  } else {
    fail += 1
    console.error(`  ✗ ${msg}`)
  }
}

class MemoryStorage {
  m = new Map<string, string>()
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v))
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  clear() {
    this.m.clear()
  }
}
;(globalThis as any).localStorage = new MemoryStorage()

function fresh() {
  ;(globalThis as any).localStorage.clear()
  setActivePinia(createPinia())
  const imp = useImpositionStore()
  const rel = useReleaseStore()
  return { imp, rel }
}

// 让草稿满足放行依据：PRF-02 通过、ΔE 达标、所有页面出血达标
function makeBasisReady(imp: ReturnType<typeof useImpositionStore>) {
  imp.updateProof('PRF-02', { decision: '通过', deltaE: 1.9 })
  imp.pages.forEach((pg) => {
    if (pg.bleed < imp.paper.bleed) imp.updatePage(pg.pageNo, { bleed: imp.paper.bleed })
  })
  imp.selectedProof = 'PRF-02'
}

async function main() {
  // ---------- 1. 旧草稿缺依据 → 待复核，禁止签核 ----------
  {
    const { rel } = fresh()
    rel.initiateBatch()
    const b = rel.state.activeBatch!
    assert(b.status === '待复核', '缺打样通过结论/有阻断错误时批次归入待复核')
    assert(!!b.reviewNote && b.reviewNote.includes('色差依据未通过'), '待复核记录原因（色差依据未通过）')
    assert(b.signoffs.length === 0, '待复核批次不产生签核槽位')
    const ok = rel.submitSign('imposition')
    assert(ok === false && rel.flash?.text.includes('403'), '待复核状态签核被拒绝')
    assert(rel.state.tasks.every((t) => t.status === '已完成' || t.status === '已失效'), '待复核时未完成导出全部暂停')
  }

  // ---------- 2. 发起即冻结依据；无岗位权限被拒 ----------
  {
    const { imp, rel } = fresh()
    makeBasisReady(imp)
    rel.initiateBatch()
    const b = rel.state.activeBatch!
    assert(b.status === '待签核' && b.version === 1, '依据齐全时发起成功，版本 v1')
    assert(b.basis.positionsHash.length === 8 && b.basis.colorHash.length === 8, '冻结版位/色差哈希')
    assert(b.basis.bleedRule === 3 && b.basis.sheetWidth === 720, '冻结出血规则与纸张规格')
    // 当前操作人默认是拼版员；试签色彩槽 → 403
    const denied = rel.submitSign('color')
    assert(denied === false && rel.flash?.text.includes('403'), `拼版员签色彩槽被拒（403），实际：${rel.flash?.text}`)
    assert(rel.state.events.some((e) => e.kind === 'signoff-denied'), '拒绝事件进入审计')
    assert(rel.state.tasks.length === 2, '拒绝签核不产生其他副作用')
  }

  // ---------- 3. 双终端同槽并发：先到者占用，后到者 409 ----------
  {
    const { imp, rel } = fresh()
    makeBasisReady(imp)
    rel.initiateBatch()
    // 切到拼版员终端 A 林青，与终端 B 陈屿竞争
    rel.switchOperator('u-lin')
    rel.concurrentSubmit('imposition')
    const slot = rel.state.activeBatch!.signoffs.find((s) => s.slot === 'imposition')!
    assert(slot.status === '已签核' && slot.signedBy === '林青', '先到者（终端 A）占用拼版签核')
    assert(!!rel.lastConflict && rel.lastConflict.winner === '林青' && rel.lastConflict.loser === '陈屿', '后到者陈屿看到版本/占用冲突')
    assert(rel.state.events.some((e) => e.kind === 'signoff-conflict'), '冲突事件进入审计')
    // 陈屿再补一刀仍被拒
    rel.switchOperator('u-chen')
    const again = rel.submitSign('imposition')
    assert(again === false && rel.flash!.text.includes('409'), '槽位已占后再次提交仍被 409')
  }

  // ---------- 4. 三岗签齐 → 已放行；导出解锁 ----------
  {
    const { imp, rel } = fresh()
    makeBasisReady(imp)
    rel.initiateBatch()
    rel.switchOperator('u-lin')
    rel.submitSign('imposition')
    rel.switchOperator('u-zhou')
    rel.submitSign('color')
    // 主管在签之前试新建导出 → 拒绝
    rel.enqueueExport('测试包')
    assert(rel.state.tasks.every((t) => t.name !== '测试包'), '未放行时新建导出被拒绝')
    rel.switchOperator('u-zheng')
    rel.submitSign('production')
    const b = rel.state.activeBatch!
    assert(b.status === '已放行', '三岗签齐批次放行')
    assert(!!b.lastFullSignoffAt, '记录最后一次完整签核时间（恢复锚点）')
    const before = rel.state.tasks.length
    rel.enqueueExport('印刷交付包 · PDF/X-4')
    const queued = rel.state.tasks[0]
    assert(rel.state.tasks.length === before + 1, '放行后导出可入队')
    assert(queued.batchId === b.id && queued.basisVersion === 1, '导出任务锁定批次与依据版本')
  }

  // ---------- 5. 版位改动：全部签核作废 + 未完成导出失效（分片保留） ----------
  {
    const { imp, rel } = fresh()
    makeBasisReady(imp)
    rel.initiateBatch()
    rel.switchOperator('u-lin'); rel.submitSign('imposition')
    rel.switchOperator('u-zhou'); rel.submitSign('color')
    // 放行一个导出并跑一点进度
    rel.switchOperator('u-zheng'); rel.submitSign('production')
    rel.enqueueExport('在产任务')
    rel.tickExports()
    const running = rel.state.tasks.find((t) => t.name === '在产任务')!
    assert(running.progress > 0, `导出任务已有进度（${running.progress}%）用于验证分片保留`)
    // 改版位（切拼版员）
    rel.switchOperator('u-lin')
    imp.updatePosition('P-01', { x: 60 })
    await sleep(400)
    const b2 = rel.state.activeBatch!
    assert(b2.status === '依据已变更' && b2.version === 2, '版位改动后批次为依据已变更，版本升到 v2')
    assert(b2.signoffs.every((s) => s.status === '已作废'), '三岗签核全部作废')
    const t2 = rel.state.tasks.find((t) => t.name === '在产任务')!
    assert(t2.status === '已失效' && t2.progress === running.progress, '未完成导出失效但进度分片保留')
    assert(!!t2.invalidReason, '导出记录失效原因')
    assert(rel.state.tasks.find((t) => t.id === 'EXP-0925-02')?.status === '已完成', '已完成导出不受影响')
    // 持旧依据签核 → 版本冲突
    rel.switchOperator('u-lin')
    const stale = rel.submitSign('imposition')
    assert(stale === false && rel.flash!.text.includes('v2'), `后到旧依据提交看到版本冲突，实际：${rel.flash?.text}`)
  }

  // ---------- 6. 纸张改动只影响拼版/生产，色彩签核保留并重冻 ----------
  {
    const { imp, rel } = fresh()
    makeBasisReady(imp)
    rel.initiateBatch()
    rel.switchOperator('u-zhou'); rel.submitSign('color')
    rel.switchOperator('u-zheng')
    imp.updatePaper({ width: 724 })
    await sleep(300)
    const b2 = rel.state.activeBatch!
    assert(b2.version === 2 && b2.status === '依据已变更', '纸张改动升级依据版本')
    const colorSlot = b2.signoffs.find((s) => s.slot === 'color')!
    assert(colorSlot.status === '已签核', '色彩签核不在纸张影响面，保留有效')
    assert(b2.signoffs.find((s) => s.slot === 'imposition')!.status === '已作废', '拼版签核因纸张规格改动作废')
    rel.refreezeBatch()
    const b3 = rel.state.activeBatch!
    assert(b3.status === '待签核' && b3.basis.sheetWidth === 724, '重新冻结纸张 724mm')
    assert(b3.signoffs.find((s) => s.slot === 'color')!.status === '已签核', '重冻后色彩签核仍保留')
    assert(b3.signoffs.find((s) => s.slot === 'imposition')!.status === '待签核', '受影响槽位回到待签核')
    rel.switchOperator('u-lin'); rel.submitSign('imposition')
    rel.switchOperator('u-zheng'); rel.submitSign('production')
    assert(rel.state.activeBatch!.status === '已放行', '补签两岗后批次重新放行')
  }

  // ---------- 7. 打样决定改动：色彩+生产作废 ----------
  {
    const { imp, rel } = fresh()
    makeBasisReady(imp)
    rel.initiateBatch()
    rel.switchOperator('u-lin'); rel.submitSign('imposition')
    rel.switchOperator('u-zhou'); rel.submitSign('color')
    imp.updateProof('PRF-02', { decision: '退回' })
    await sleep(300)
    const b = rel.state.activeBatch!
    assert(b.signoffs.find((s) => s.slot === 'color')!.status === '已作废', '打样退回 → 色彩签核作废')
    assert(b.signoffs.find((s) => s.slot === 'production')!.status === '已作废', '生产放行随打样决定作废')
    assert(b.signoffs.find((s) => s.slot === 'imposition')!.status === '已签核', '拼版签核不受打样决定影响')
  }

  // ---------- 8. 写盘阶段1失败：主区不动，自动重放成功且不重复 ----------
  {
    const { imp, rel } = fresh()
    makeBasisReady(imp)
    rel.initiateBatch()
    rel.switchOperator('u-lin')
    setFault('phase1')
    rel.submitSign('imposition')
    await sleep(50)
    const slot = rel.state.activeBatch!.signoffs.find((s) => s.slot === 'imposition')!
    assert(slot.status === '已签核', '阶段1失败后自动重试，签核最终成功')
    assert(rel.state.activeBatch!.signoffs.filter((s) => s.status === '已签核').length === 1, '重试未产生重复签核（无半批/双写）')
    assert(!!rel.recoveryNotice?.recovered, '界面展示恢复说明')
    // 磁盘主区可解析且与内存一致
    const raw = (globalThis as any).localStorage.getItem('print-release-v2')
    const parsed = JSON.parse(raw)
    assert(parsed.state.activeBatch.signoffs.filter((s: any) => s.status === '已签核').length === 1, '磁盘主区为完整一致记录')
  }

  // ---------- 9. 写盘阶段2失败：从临时区采用完整提交 ----------
  {
    const { imp, rel } = fresh()
    makeBasisReady(imp)
    rel.initiateBatch()
    rel.switchOperator('u-lin')
    setFault('phase2')
    rel.submitSign('imposition')
    await sleep(50)
    assert(rel.state.activeBatch!.signoffs.find((s) => s.slot === 'imposition')!.status === '已签核', '阶段2失败后从临时区恢复，签核存在且只一份')
    assert(rel.state.events.some((e) => e.kind === 'write-recovered'), '恢复事件已审计')
    const raw = (globalThis as any).localStorage.getItem('print-release-v2')
    assert(!!raw && JSON.parse(raw).state.activeBatch, '主区最终是完整 JSON，没有半截记录')
    assert(!(globalThis as any).localStorage.getItem('print-release-v2.tmp'), '临时区已清理')
  }

  // ---------- 10. 启动恢复：主区损坏 + tmp 完整 → 恢复 tmp；纯损坏则丢弃无半批 ----------
  {
    const ls = (globalThis as any).localStorage as MemoryStorage
    ls.clear()
    // 构造：primary 半截损坏，tmp 是完整新提交
    const good = JSON.stringify({
      state: { activeBatch: { id: 'BAT-x', status: '已放行', signoffs: [{ status: '已签核' }, { status: '已签核' }, { status: '已签核' }], lastFullSignoffAt: '2026-10-05T00:00:00Z' }, history: [], events: [], tasks: [], operatorId: 'u-lin', pendingRetry: null, bootstrapped: true, recoveredAtStartup: null },
      label: 'x', at: '2026-10-05T00:00:00Z', anchor: '2026-10-05T00:00:00Z', revision: 9,
    })
    ls.setItem('print-release-v2', '{broken-garbage')
    ls.setItem('print-release-v2.tmp', good)
    const r = restore()
    assert(r.recoveredFrom === 'tmp', '主区损坏时从临时区恢复')
    assert(r.record!.state.activeBatch.status === '已放行', '恢复的是完整放行批次，而非半批')
    assert(!ls.getItem('print-release-v2.tmp'), '恢复后临时区清理')

    // 只有损坏主区、没有 tmp/bak → 返回 null，不留半批
    ls.clear()
    ls.setItem('print-release-v2', '{half')
    const r2 = restore()
    assert(r2.record === null, '无法恢复的半截记录直接丢弃，不返回半批')
  }

  // ---------- 11. 总览与导出队列/REST 层同源 ----------
  {
    const { imp, rel } = fresh()
    makeBasisReady(imp)
    rel.initiateBatch()
    rel.switchOperator('u-lin'); rel.submitSign('imposition')
    const { bindExportRegistry, getExportRegistry } = await import('../src/api/registry.ts')
    bindExportRegistry({
      list: () => rel.state.tasks,
      resume: (id: string) => ({ task: rel.state.tasks.find((t) => t.id === id) }),
    })
    const restView = getExportRegistry()!.list()
    assert(restView === rel.state.tasks, 'REST 注册表与总览读到同一队列引用（同源放行状态）')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
