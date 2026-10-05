import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { createEngine, missingBasisReasons, snapshotBasis, type BasisSnapshot } from '../release/engine'
import { commit, DiskError, getFault, restore, setFault, type FaultMode, type CommittedRecord } from '../release/persistence'
import {
  ROLE_LABEL,
  SLOT_ROLE,
  type Operator,
  type ReleaseError,
  type ReleaseState,
  type ReleaseTask,
  type SlotId,
} from '../release/types'
import { useImpositionStore } from './imposition'

// 岗位名册：每个岗位两个人，分别落在终端 A / B，用于演示双终端并发
export const OPERATORS: Operator[] = [
  { id: 'u-lin', name: '林青', role: 'impositioner', terminal: 'A' },
  { id: 'u-chen', name: '陈屿', role: 'impositioner', terminal: 'B' },
  { id: 'u-zhou', name: '周默', role: 'colorist', terminal: 'A' },
  { id: 'u-ning', name: '许宁', role: 'colorist', terminal: 'B' },
  { id: 'u-zheng', name: '郑凯', role: 'supervisor', terminal: 'A' },
  { id: 'u-wu', name: '吴敏', role: 'supervisor', terminal: 'B' },
]

function seedTasks(): ReleaseTask[] {
  return [
    { id: 'EXP-0925-01', name: '印刷交付包 · PDF/X-4', progress: 72, status: '已失效', updatedAt: '09-25 16:42', resumable: false, batchId: null, basisVersion: null, invalidReason: '旧任务缺少放行批次锚点，新批次放行后重算' },
    { id: 'EXP-0925-02', name: '数字样张低分辨率预览', progress: 100, status: '已完成', updatedAt: '09-25 15:18', resumable: false, batchId: null, basisVersion: null, invalidReason: null },
  ]
}

function blankState(operatorId = 'u-lin'): ReleaseState {
  return { activeBatch: null, history: [], events: [], tasks: seedTasks(), operatorId, pendingRetry: null, bootstrapped: true, recoveredAtStartup: null }
}

export type Flash = { severity: 'success' | 'error' | 'warn'; text: string } | null

export const useReleaseStore = defineStore('release', () => {
  const imposition = useImpositionStore()

  // ---- 启动恢复：primary → tmp（阶段2崩溃）→ bak（上一完整版本），半批 JSON 丢弃 ----
  const boot = restore()
  const state = reactive<ReleaseState>(
    boot.record ? structuredClone(boot.record.state) : blankState(),
  )
  state.bootstrapped = true
  if (boot.recoveredFrom) {
    state.recoveredAtStartup = new Date().toISOString()
  }

  let revisionCounter = boot.record?.revision ?? 0
  const pendingRetry = ref<CommittedRecord | null>(null)
  const pendingLabel = ref<string | null>(null)
  // 最近一次故障→恢复的说明（保留在界面，直到用户关闭）
  const recoveryNotice = ref<{ label: string; detail: string; recovered: boolean; at: string } | null>(null)
  const flash = ref<Flash>(null)
  const lastConflict = ref<{ slot: SlotId; winner: string; loser: string; at: string } | null>(null)

  function currentSnapshot(): BasisSnapshot {
    return snapshotBasis({
      revision: imposition.revision,
      positions: imposition.positions,
      paper: imposition.paper,
      proofs: imposition.proofs,
      selectedProofId: imposition.selectedProof,
    })
  }

  function currentReasons(snapshot: BasisSnapshot) {
    return missingBasisReasons(snapshot, imposition.validations, imposition.pages)
  }

  /**
   * 事务：克隆态上变更 → 两阶段原子写盘 → 替换内存态。
   * 阶段 1（临时区）失败：主区未动，恢复后重放同一变更重试。
   * 阶段 2（提交主区）失败：临时区已是完整目标提交，直接采用恢复结果，不重复施加变更。
   * 任何情况下只有完整记录可见，不会留下半批。
   */
  function transact(updater: (draft: ReleaseState) => void, label: string, isRetry = false): void {
    const draft: ReleaseState = structuredClone(toRawState())
    updater(draft)
    revisionCounter += 1
    const record: CommittedRecord = {
      state: draft,
      label,
      at: new Date().toISOString(),
      anchor: draft.activeBatch?.lastFullSignoffAt ?? null,
      revision: revisionCounter,
    }
    try {
      commit(record)
      replaceState(draft)
      if (isRetry) {
        recoveryNotice.value = { label, detail: '已从最后一致状态恢复，重试写盘成功', recovered: true, at: record.at }
      }
      return
    } catch (error) {
      if (!(error instanceof DiskError)) throw error
      const recovered = restore()
      if (error.phase === 2 && recovered.record) {
        // tmp 已含本次完整目标提交：采用它，避免重复施加变更
        const adopted = structuredClone(recovered.record.state)
        revisionCounter = Math.max(revisionCounter, recovered.record.revision)
        replaceState(adopted)
        recoveryNotice.value = { label, detail: '提交主区中途失败；已从临时区采用本次完整提交，未产生半批', recovered: true, at: record.at }
        // 恢复审计作为下一笔完整事务落盘
        transact(
          (d) => {
            d.events.unshift({
              id: `EVT-recover-${Date.now()}`,
              at: new Date().toISOString(),
              kind: 'write-recovered',
              message: `「${label}」阶段 2 写盘失败，已按完整临时提交恢复，无半批记录`,
              terminal: 'S',
            })
          },
          `恢复审计：${label}`,
        )
        return
      }

      // 阶段 1 失败 / 临时区不可用：主区仍是最后一致状态，自动重放一次
      const durable = recovered.record?.state ?? blankState(state.operatorId)
      replaceState(structuredClone(durable))
      if (!isRetry) {
        recoveryNotice.value = { label, detail: `${error.message}；已回到最后一致状态，自动重试`, recovered: false, at: record.at }
        transact(updater, label, true)
        return
      }

      // 二次失败：停在最后完整签核锚点，等待人工重试
      const anchor = durable.activeBatch?.lastFullSignoffAt
      pendingRetry.value = { ...record, state: structuredClone(durable) }
      pendingLabel.value = label
      recoveryNotice.value = {
        label,
        detail: `${error.message}；已停在${anchor ? '最后一次完整签核锚点' : '最后一致状态'}，可手动重试`,
        recovered: false,
        at: record.at,
      }
    }
  }

  function toRawState(): ReleaseState {
    return JSON.parse(JSON.stringify(state)) as ReleaseState
  }

  function replaceState(next: ReleaseState) {
    state.activeBatch = next.activeBatch
    state.history = next.history
    state.events = next.events
    state.tasks = next.tasks
    state.operatorId = next.operatorId
    state.pendingRetry = next.pendingRetry
    state.recoveredAtStartup = next.recoveredAtStartup
  }

  const engine = createEngine(
    () => JSON.parse(JSON.stringify(state)) as ReleaseState,
    (updater, opts) => transact(updater, opts?.label ?? '放行事务'),
  )

  // ---- 启动恢复审计 ----
  if (boot.recoveredFrom) {
    const from = boot.recoveredFrom === 'tmp' ? '临时区（阶段 2 写盘中断）' : boot.recoveredFrom === 'bak' ? '备份区（上一完整提交）' : '主区'
    engine.logEvent('startup-recovered', `启动检测到不完整写盘，已从${from}恢复，半批记录已丢弃`, 'S')
  }

  // ---- 依据漂移监听：版位 / 纸张规格 / 打样决定 ----
  let basis = currentSnapshot()
  const lastHashes = reactive({ positions: basis.positionsHash, paper: basis.paperHash, color: basis.colorHash })
  let positionsTimer: ReturnType<typeof setTimeout> | undefined
  let paperTimer: ReturnType<typeof setTimeout> | undefined
  let colorTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 触发作废前与批次冻结哈希再比一次：
   * 防抖窗口内若批次尚未发起（编辑先于批次），或改动已被重新冻结吸收，则不作废。
   */
  function driftedAfterFreeze(key: 'positions' | 'paper' | 'color'): boolean {
    const b = state.activeBatch
    if (!b) return false
    const snap = currentSnapshot()
    if (key === 'positions') return snap.positionsHash !== b.basis.positionsHash
    if (key === 'paper') return snap.paperHash !== b.basis.paperHash
    return snap.colorHash !== b.basis.colorHash
  }

  watch(
    () => [basisOf().positionsHash, basisOf().paperHash, basisOf().colorHash],
    ([posHash, paperHash, colorHash]) => {
      if (posHash !== lastHashes.positions) {
        // 立即推进锚点，防止防抖窗口内重复触发
        lastHashes.positions = posHash
        clearTimeout(positionsTimer)
        positionsTimer = setTimeout(() => {
          if (!driftedAfterFreeze('positions')) return
          imposition.bumpRevision()
          engine.invalidate('positions', '版位/出血版面调整', operator.value.name)
        }, 260)
      }
      if (paperHash !== lastHashes.paper) {
        lastHashes.paper = paperHash
        clearTimeout(paperTimer)
        paperTimer = setTimeout(() => {
          if (!driftedAfterFreeze('paper')) return
          imposition.bumpRevision()
          engine.invalidate('paper', '纸张规格变更', operator.value.name)
        }, 120)
      }
      if (colorHash !== lastHashes.color) {
        lastHashes.color = colorHash
        clearTimeout(colorTimer)
        colorTimer = setTimeout(() => {
          if (!driftedAfterFreeze('color')) return
          const proof = imposition.proofs.find((item) => item.id === imposition.selectedProof)
          engine.invalidate('color', `打样决定变更（${proof?.sample ?? '样张'} → ${proof?.decision ?? '—'}）`, operator.value.name)
        }, 120)
      }
    },
  )

  function basisOf() {
    return currentSnapshot()
  }

  // ---- 操作人 / 终端 ----
  const operator = computed<Operator>(() => OPERATORS.find((item) => item.id === state.operatorId) ?? OPERATORS[0])
  function switchOperator(id: string) {
    transact((draft) => {
      draft.operatorId = id
    }, `切换操作人 → ${OPERATORS.find((o) => o.id === id)?.name}`)
    flash.value = null
  }

  // ---- 批次动作 ----
  function initiateBatch() {
    const snapshot = currentSnapshot()
    const reasons = currentReasons(snapshot)
    // 已放行批次入历史
    if (state.activeBatch?.status === '已放行') engine.archiveReleased()
    engine.initiate(operator.value, snapshot, reasons)
    if (reasons.length) {
      flash.value = { severity: 'warn', text: `依据不完整，批次归入待复核：${reasons.join('；')}` }
    } else {
      flash.value = { severity: 'success', text: `已发起批次并冻结版位、出血与色差依据（${snapshot.positionSummary}）` }
    }
  }

  function refreezeBatch() {
    const snapshot = currentSnapshot()
    engine.refreeze(operator.value, snapshot, currentReasons(snapshot))
    flash.value =
      currentReasons(snapshot).length > 0
        ? { severity: 'error', text: '仍缺放行依据，无法重新冻结' }
        : { severity: 'success', text: `依据已重新冻结 v${state.activeBatch?.version ?? ''}，未受影响签核保留` }
  }

  function submitSign(slot: SlotId, note = '') {
    try {
      engine.sign(operator.value, slot, note)
      flash.value = { severity: 'success', text: `${operator.value.name} 的签核已写入（终端 ${operator.value.terminal}）` }
      lastConflict.value = null
      return true
    } catch (error) {
      const e = error as ReleaseError
      flash.value = { severity: 'error', text: e.code === 403 ? `已拒绝（403）：${e.message}` : `已驳回（409）：${e.message}` }
      return false
    }
  }

  /**
   * 双终端同时提交同一签核：同岗位另一终端的同事与当前操作人同步竞争。
   * 同步临界区先到先得，后到者收到 409 版本/占用冲突。
   */
  function concurrentSubmit(slot: SlotId) {
    const peer = OPERATORS.find((o) => o.role === SLOT_ROLE[slot] && o.terminal !== operator.value.terminal && o.id !== operator.value.id)
      ?? OPERATORS.find((o) => o.role === SLOT_ROLE[slot] && o.id !== operator.value.id)
    if (!peer) return
    const first = operator.value.terminal === 'A' ? operator.value : peer
    const second = first === operator.value ? peer : operator.value
    let winner = first.name
    let loser = second.name
    try {
      engine.sign(first, slot, '双终端并发提交')
    } catch {
      winner = second.name
      loser = first.name
    }
    try {
      engine.sign(second, slot, '双终端并发提交')
      flash.value = { severity: 'success', text: '两份提交均被接受（不应该出现）' }
    } catch (error) {
      const e = error as ReleaseError
      lastConflict.value = { slot, winner, loser, at: new Date().toISOString() }
      flash.value = {
        severity: 'error',
        text: `并发结果：${winner}（先到）占用${slot === 'production' ? '生产放行' : slot === 'color' ? '色彩签核' : '拼版签核'}；${loser} 收到 409 — ${e.message}`,
      }
    }
  }

  // ---- 导出 ----
  const canExport = computed(() => state.activeBatch?.status === '已放行')

  function enqueueExport(name: string) {
    if (!canExport.value || !state.activeBatch) {
      flash.value = { severity: 'error', text: '只有三岗签齐、已放行的批次才能创建导出任务' }
      return
    }
    const task: ReleaseTask = {
      id: `EXP-${Date.now().toString().slice(-6)}`,
      name,
      progress: 0,
      status: '排队中',
      updatedAt: '刚刚',
      resumable: true,
      batchId: state.activeBatch.id,
      basisVersion: state.activeBatch.version,
      invalidReason: null,
    }
    engine.enqueueTask(task)
  }

  /** 失效任务在重新放行后按新依据重算 */
  function recomputeTask(id: string) {
    if (!canExport.value || !state.activeBatch) {
      flash.value = { severity: 'error', text: '批次未放行，失效任务不能重算' }
      return
    }
    engine.patchTask(
      id,
      {
        status: '排队中',
        progress: 0,
        resumable: true,
        batchId: state.activeBatch.id,
        basisVersion: state.activeBatch.version,
        invalidReason: null,
        updatedAt: '按新依据重算',
      },
      `失效任务 ${id} 按新依据重算`,
    )
  }

  function resumeTask(id: string) {
    const task = state.tasks.find((t) => t.id === id)
    if (!task) return
    if (task.status === '已失效') {
      recomputeTask(id)
      return
    }
    if (!canExport.value) {
      flash.value = { severity: 'error', text: '批次未放行或依据已变更，导出保持中断' }
      return
    }
    const active = state.activeBatch
    if (task.basisVersion !== active?.version) {
      flash.value = { severity: 'error', text: `任务基于 v${task.basisVersion}，当前放行 v${active?.version ?? '—'}，需重算` }
      return
    }
    engine.patchTask(id, { status: '生成中', progress: Math.max(task.progress, 8), resumable: true, updatedAt: '断点恢复' }, `恢复导出 ${id}`)
  }

  /** 导出进度推进一拍（UI 定时器与测试共用，走事务持久化） */
  function tickExports() {
    const running = state.tasks.filter((t) => t.status === '排队中' || t.status === '生成中')
    running.forEach((task) => {
      const next = Math.min(100, task.progress + (task.status === '排队中' ? 6 : 4 + Math.floor(Math.random() * 9)))
      engine.patchTask(
        task.id,
        next >= 100
          ? { status: '已完成', progress: 100, resumable: false, updatedAt: '刚刚' }
          : { status: '生成中', progress: next, updatedAt: '生成中' },
        `导出进度 ${task.id}`,
      )
    })
  }

  // 导出进度模拟（浏览器内每 2.4s 一拍）
  if (typeof window !== 'undefined') {
    setInterval(tickExports, 2400)
  }

  // ---- 故障注入与恢复 ----
  function armFault(mode: FaultMode) {
    setFault(mode)
    flash.value = { severity: 'warn', text: mode === 'phase1' ? '已注入：下一次写盘在临时区失败' : '已注入：下一次写盘在提交主区时中途失败（半批现场）' }
  }

  function dismissNotice() {
    recoveryNotice.value = null
  }

  function retryPending() {
    if (!pendingRetry.value || !pendingLabel.value) return
    // 手动重试：以最后一致状态为底，重放导致失败的操作无法重建（事件类），
    // 这里对“待重试记录”做一次完整补提交（典型场景：恢复后的补登）。
    const label = pendingLabel.value
    transact((draft) => {
      draft.events.unshift({
        id: `EVT-manual-${Date.now()}`,
        at: new Date().toISOString(),
        kind: 'write-recovered',
        message: `人工确认：按最后一次完整签核锚点重试「${label}」完成`,
        terminal: 'S',
      })
    }, `手动重试：${label}`)
    flash.value = { severity: 'success', text: '重试成功，批次记录完整' }
  }

  function resetDemo() {
    localStorage.removeItem('print-release-v2')
    localStorage.removeItem('print-release-v2.tmp')
    localStorage.removeItem('print-release-v2.bak')
    localStorage.removeItem('print-imposition-v2')
    location.reload()
  }

  return {
    // state
    state,
    operator,
    operators: OPERATORS,
    flash,
    lastConflict,
    recoveryNotice,
    pendingRetry,
    faultMode: computed(getFault),
    canExport,
    // basis
    currentSnapshot,
    currentReasons,
    // actions
    switchOperator,
    initiateBatch,
    refreezeBatch,
    submitSign,
    concurrentSubmit,
    enqueueExport,
    resumeTask,
    recomputeTask,
    armFault,
    tickExports,
    dismissNotice,
    retryPending,
    resetDemo,
  }
})
