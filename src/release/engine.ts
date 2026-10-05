import {
  BASIS_SLOT_IMPACT,
  ReleaseError,
  ROLE_LABEL,
  SLOT_LABEL,
  SLOT_ROLE,
  type BatchStatus,
  type BasisKey,
  type FrozenBasis,
  type Operator,
  type ProofBasis,
  type ReleaseBatch,
  type ReleaseEvent,
  type ReleaseEventKind,
  type ReleaseState,
  type ReleaseTask,
  type Signoff,
  type SlotId,
} from './types'
import type { Page, Position, Proof, Validation } from '../stores/imposition'

// 纯函数引擎：不触碰 Vue/localStorage，状态读写由 store 注入（写路径走事务）。

function now() {
  return new Date().toISOString()
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

// FNV-1a 32 位，够用的非加密哈希，标识依据是否漂移
export function hashOf(value: unknown): string {
  const text = stableStringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export type PaperSpec = {
  width: number
  height: number
  bleed: number
  safe: number
  gutter: number
  binding: string
  grain: string
}

export type BasisInput = {
  revision: string
  positions: Position[]
  paper: PaperSpec
  proofs: Proof[]
  /** 作为色差依据的打样轮次 id */
  selectedProofId: string | null
}

export type BasisSnapshot = {
  positionsHash: string
  paperHash: string
  colorHash: string
  proof: ProofBasis | null
  positionSummary: string
  bleedSummary: string
  revision: string
  paper: PaperSpec
}

export function snapshotBasis(input: BasisInput): BasisSnapshot {
  const positionsBasis = input.positions
    .map((p) => ({ id: p.id, pageNo: p.pageNo, x: p.x, y: p.y, rotation: p.rotation, front: p.front }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const proof = input.proofs.find((item) => item.id === input.selectedProofId) ?? null
  const colorBasis = proof
    ? {
        proofId: proof.id,
        round: proof.round,
        sample: proof.sample,
        decision: proof.decision,
        deltaE: proof.deltaE,
        owner: proof.owner,
        correction: proof.correction,
      }
    : null
  return {
    revision: input.revision,
    positionsHash: hashOf(positionsBasis),
    paperHash: hashOf(input.paper),
    colorHash: hashOf(colorBasis),
    proof: proof
      ? {
          proofId: proof.id,
          round: proof.round,
          sample: proof.sample,
          decision: proof.decision === '通过' ? '通过' : proof.decision === '退回' ? '退回' : '待决定',
          deltaE: proof.deltaE,
          decidedBy: proof.owner,
          decidedAt: proof.date,
        }
      : null,
    positionSummary: `${positionsBasis.length} 个版位 · ${input.revision}`,
    bleedSummary: `出血规则 ≥ ${input.paper.bleed}mm · 安全区 ${input.paper.safe}mm · 装订 ${input.paper.binding}`,
    paper: input.paper,
  }
}

/** 旧草稿缺依据：没有通过的打样决定、色差超标，或仍存在阻断级预检错误 */
export function missingBasisReasons(snapshot: BasisSnapshot, validations: Validation[], pages: Page[]): string[] {
  const reasons: string[] = []
  if (!snapshot.proof) reasons.push('缺少打样记录（无色差依据）')
  else if (snapshot.proof.decision !== '通过') reasons.push(`色差依据未通过：${snapshot.proof.sample} 结论为「${snapshot.proof.decision}」`)
  if (snapshot.proof && snapshot.proof.deltaE > 2.0) reasons.push(`平均色差 ΔE ${snapshot.proof.deltaE} 超过放行阈值 2.0`)
  const blocking = validations.filter((item) => item.severity === '错误')
  if (blocking.length) reasons.push(`存在 ${blocking.length} 项阻断级预检错误（出血/重叠/缺页）`)
  if (pages.some((page) => page.bleed < snapshot.paper.bleed)) reasons.push('存在页面出血低于纸张规格')
  return reasons
}

let sequence = 0
function nextId(prefix: string) {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`
}

export function blankSignoffs(version = 1): Signoff[] {
  return (Object.keys(SLOT_ROLE) as SlotId[]).map((slot) => ({
    slot,
    requiredRole: SLOT_ROLE[slot],
    status: '待签核',
    basisVersion: version,
    signedBy: null,
    signedRole: null,
    terminal: null,
    signedAt: null,
    note: '',
    invalidatedBy: null,
  }))
}

function makeEvent(kind: ReleaseEventKind, message: string, terminal: 'A' | 'B' | 'S' | null = null): ReleaseEvent {
  return { id: nextId('EVT'), at: now(), kind, message, terminal }
}

export function deriveStatus(batch: ReleaseBatch): BatchStatus {
  if (batch.status === '已归档') return '已归档'
  if (batch.status === '待复核') return '待复核'
  if (batch.signoffs.some((s) => s.status === '已作废')) return '依据已变更'
  if (batch.signoffs.length > 0 && batch.signoffs.every((s) => s.status === '已签核')) return '已放行'
  return '待签核'
}

export type Engine = ReturnType<typeof createEngine>

/**
 * 放行引擎。所有变更走注入的 write（store 侧实现为事务：内存态 + 原子写盘）。
 * - initiate 发起并冻结版位/出血/色差依据
 * - sign 岗位签核：403 无权限；409 版本冲突/槽位先到先得
 * - invalidate 依据改动：受影响签核作废 + 未完成导出同事务失效
 * - refreeze 重新冻结，未受影响的已签槽位保留
 */
export function createEngine(
  read: () => ReleaseState,
  write: (updater: (draft: ReleaseState) => void, opts?: { label?: string }) => void,
) {
  function pushEvent(draft: ReleaseState, evt: ReleaseEvent) {
    draft.events.unshift(evt)
    draft.events = draft.events.slice(0, 80)
  }

  function freezeBasis(snapshot: BasisSnapshot, operator: Operator): FrozenBasis {
    const proof: ProofBasis = snapshot.proof ?? {
      proofId: 'MISSING',
      round: 0,
      sample: '缺少打样依据',
      decision: '待决定',
      deltaE: 0,
      decidedBy: '',
      decidedAt: '',
    }
    return {
      revision: snapshot.revision,
      positionsHash: snapshot.positionsHash,
      paperHash: snapshot.paperHash,
      colorHash: snapshot.colorHash,
      sheetWidth: snapshot.paper.width,
      sheetHeight: snapshot.paper.height,
      bleedRule: snapshot.paper.bleed,
      safeRule: snapshot.paper.safe,
      gutter: snapshot.paper.gutter,
      binding: snapshot.paper.binding,
      grain: snapshot.paper.grain,
      proof,
      frozenAt: now(),
      frozenBy: operator.name,
      positionSummary: snapshot.positionSummary,
      bleedSummary: snapshot.bleedSummary,
    }
  }

  function initiate(operator: Operator, snapshot: BasisSnapshot, reasons: string[]) {
    write(
      (draft) => {
        if (reasons.length > 0) {
          // 旧草稿缺依据 → 待复核：不产生签核槽位、不允许导出
          draft.activeBatch = {
            id: nextId('BAT'),
            revision: snapshot.revision,
            status: '待复核',
            version: 0,
            initiatedAt: now(),
            initiatedBy: operator.name,
            basis: freezeBasis(snapshot, operator),
            signoffs: [],
            refrozenAt: null,
            refrozenBy: null,
            reviewNote: reasons.join('；'),
            lastFullSignoffAt: null,
          }
          // 待复核批次下未完成导出一并暂停，避免半批流出
          const paused = draft.tasks.filter((t) => t.status !== '已完成' && t.status !== '已失效')
          paused.forEach((t) => {
            t.status = '已失效'
            t.resumable = false
            t.invalidReason = '批次待复核：依据不完整'
            t.updatedAt = '待复核'
          })
          pushEvent(draft, makeEvent('review-flagged', `旧草稿缺依据，归入待复核：${reasons.join('；')}`, operator.terminal))
          if (paused.length) pushEvent(draft, makeEvent('export-invalidated', `未完成导出 ${paused.map((t) => t.id).join('、')} 已暂停（待复核禁止产出）`, 'S'))
          return
        }
        draft.activeBatch = {
          id: nextId('BAT'),
          revision: snapshot.revision,
          status: '待签核',
          version: 1,
          initiatedAt: now(),
          initiatedBy: operator.name,
          basis: freezeBasis(snapshot, operator),
          signoffs: blankSignoffs(1),
          refrozenAt: null,
          refrozenBy: null,
          reviewNote: null,
          lastFullSignoffAt: null,
        }
        pushEvent(draft, makeEvent('batch-initiated', `${operator.name}（${ROLE_LABEL[operator.role]}）发起批次，冻结版位/出血/色差依据 v1`, operator.terminal))
      },
      { label: '发起放行批次' },
    )
  }

  /**
   * 岗位签核。同步临界区（JS 单线程 + 注入事务）保证先到者占用。
   * 失败抛 ReleaseError：403 岗位不符，409 版本冲突/槽位已占。
   */
  function sign(operator: Operator, slot: SlotId, note = '') {
    const batch = read().activeBatch
    if (!batch) throw new ReleaseError(409, '尚无可签核的放行批次')
    if (batch.status === '待复核') throw new ReleaseError(403, '批次处于待复核，依据补齐前禁止签核')
    if (batch.status === '已放行' || batch.status === '已归档') throw new ReleaseError(409, '批次已放行，不能重复签核')

    // 403：岗位权限校验
    if (SLOT_ROLE[slot] !== operator.role) {
      write((draft) =>
        pushEvent(
          draft,
          makeEvent(
            'signoff-denied',
            `${operator.name}（${ROLE_LABEL[operator.role]}）尝试${SLOT_LABEL[slot]}被拒绝：该签核仅 ${ROLE_LABEL[SLOT_ROLE[slot]]} 可执行`,
            operator.terminal,
          ),
        ),
      )
      throw new ReleaseError(403, `无岗位权限：${SLOT_LABEL[slot]} 仅限 ${ROLE_LABEL[SLOT_ROLE[slot]]}`)
    }

    const target = batch.signoffs.find((s) => s.slot === slot)
    if (!target) throw new ReleaseError(409, '签核槽位不存在')

    // 409：后到者手持旧版本提交（依据已升级）
    if (target.basisVersion !== batch.version || target.status === '已作废') {
      write((draft) =>
        pushEvent(
          draft,
          makeEvent(
            'signoff-conflict',
            `版本冲突：${operator.name} 基于旧依据 v${target.basisVersion} 提交${SLOT_LABEL[slot]}，当前为 v${batch.version}，提交被驳回`,
            operator.terminal,
          ),
        ),
      )
      throw new ReleaseError(409, `版本冲突：依据已更新到 v${batch.version}，请刷新后重签`, {
        slot,
        currentVersion: batch.version,
      })
    }

    // 409：同槽位先到者占用（双终端同时提交同岗位）
    if (target.status === '已签核') {
      write((draft) =>
        pushEvent(
          draft,
          makeEvent(
            'signoff-conflict',
            `并发冲突：${SLOT_LABEL[slot]}已被 ${target.signedBy}（终端 ${target.terminal}）先占用，${operator.name}（终端 ${operator.terminal}）的提交被驳回`,
            operator.terminal,
          ),
        ),
      )
      throw new ReleaseError(409, `签核槽位已被 ${target.signedBy} 先占用`, { slot, winner: target.signedBy ?? undefined })
    }

    write(
      (draft) => {
        const b = draft.activeBatch
        if (!b) return
        const signoff = b.signoffs.find((s) => s.slot === slot)
        // 事务内二次确认（防止排队中的过期提交）
        if (!signoff || signoff.status !== '待签核' || signoff.basisVersion !== b.version) return
        signoff.status = '已签核'
        signoff.signedBy = operator.name
        signoff.signedRole = operator.role
        signoff.terminal = operator.terminal
        signoff.signedAt = now()
        signoff.note = note
        pushEvent(draft, makeEvent('signoff-accepted', `${operator.name} 在终端 ${operator.terminal} 完成${SLOT_LABEL[slot]}（依据 v${b.version}）`, operator.terminal))
        if (b.signoffs.every((s) => s.status === '已签核')) {
          b.status = '已放行'
          b.lastFullSignoffAt = now()
          pushEvent(draft, makeEvent('released', `三岗签核齐全，批次 ${b.id} 放行`, 'S'))
        } else {
          b.status = deriveStatus(b)
        }
      },
      { label: `${operator.name} 提交${SLOT_LABEL[slot]}` },
    )
  }

  /**
   * 依据改动（版位 / 纸张规格 / 打样决定）：
   * - 受影响签核立即作废、版本 +1，未受影响槽位平移保留
   * - 同一事务内未完成导出（排队/生成/中断）置「已失效」，进度保留
   */
  function invalidate(changedKey: BasisKey, changeSummary: string, operatorName: string) {
    const batch = read().activeBatch
    if (!batch || batch.status === '已归档') return
    const slots = BASIS_SLOT_IMPACT[changedKey]
    write(
      (draft) => {
        const b = draft.activeBatch
        if (!b) return
        const affectedTasks = draft.tasks.filter((t) => t.status !== '已完成' && t.status !== '已失效')
        affectedTasks.forEach((t) => {
          t.status = '已失效'
          t.resumable = false
          t.invalidReason = changeSummary
          t.updatedAt = '依据变更'
        })
        if (b.status === '待复核') {
          pushEvent(draft, makeEvent('basis-invalidated', `${operatorName} 修改${changeSummary}；批次处于待复核`, 'S'))
          if (affectedTasks.length) {
            pushEvent(draft, makeEvent('export-invalidated', `未完成导出 ${affectedTasks.map((t) => t.id).join('、')} 保持暂停（待复核禁止产出）`, 'S'))
          }
          return
        }
        const hadLive = b.signoffs.some((s) => slots.includes(s.slot))
        b.version += 1
        b.signoffs.forEach((s) => {
          if (slots.includes(s.slot)) {
            s.status = '已作废'
            s.invalidatedBy = changeSummary
          }
          // 所有槽位版本号平移到新依据
          s.basisVersion = b.version
        })
        b.status = '依据已变更'
        if (hadLive) {
          pushEvent(draft, makeEvent('basis-invalidated', `${operatorName} 改动${changeSummary}：${slots.map((s) => SLOT_LABEL[s]).join('、')}作废重算，依据升级 v${b.version}`, 'S'))
        }
        if (affectedTasks.length) {
          pushEvent(draft, makeEvent('export-invalidated', `未完成导出 ${affectedTasks.map((t) => t.id).join('、')} 随依据变更失效（分片保留，放行后重算）`, 'S'))
        }
      },
      { label: `${operatorName} 修改${changeSummary}` },
    )
  }

  /** 重新冻结：作废槽位重建待签；未受影响的已签槽位平移保留 */
  function refreeze(operator: Operator, snapshot: BasisSnapshot, reasons: string[]) {
    write(
      (draft) => {
        const b = draft.activeBatch
        if (!b) return
        if (reasons.length > 0) {
          b.status = '待复核'
          b.reviewNote = reasons.join('；')
          pushEvent(draft, makeEvent('review-flagged', `重新冻结被拦截，仍缺依据：${reasons.join('；')}`, operator.terminal))
          return
        }
        // invalidate 已按影响面作废旧槽位；未作废的已签槽位在新版本继续有效
        const kept = b.signoffs.filter((s) => s.status === '已签核')
        const invalid = b.signoffs.filter((s) => s.status === '已作废')
        b.basis = freezeBasis(snapshot, operator)
        b.revision = snapshot.revision
        b.refrozenAt = now()
        b.refrozenBy = operator.name
        b.status = '待签核'
        b.reviewNote = null
        b.signoffs = blankSignoffs(b.version).map((fresh) => {
          const survivor = kept.find((s) => s.slot === fresh.slot)
          return survivor ? { ...survivor, basisVersion: b.version, invalidatedBy: null } : fresh
        })
        pushEvent(
          draft,
          makeEvent(
            'basis-refrozen',
            `${operator.name} 重新冻结依据 v${b.version}：保留 ${kept.length} 岗签核，${invalid.length} 岗需重签`,
            operator.terminal,
          ),
        )
      },
      { label: `${operator.name} 重新冻结依据` },
    )
  }

  /** 归档已放行批次（演示“放行后进入导出”闭环） */
  function archiveReleased() {
    write(
      (draft) => {
        const b = draft.activeBatch
        if (!b || b.status !== '已放行') return
        draft.history.unshift({ id: b.id, revision: b.revision, releasedAt: b.lastFullSignoffAt ?? now(), basisVersion: b.version })
      },
      { label: '归档已放行批次' },
    )
  }

  function enqueueTask(task: ReleaseTask) {
    write(
      (draft) => {
        draft.tasks.unshift(task)
        pushEvent(draft, makeEvent('export-queued', `导出任务 ${task.id} 已入队（批次 ${task.batchId ?? '—'} v${task.basisVersion ?? '—'}）`, 'S'))
      },
      { label: `新建导出 ${task.id}` },
    )
  }

  function patchTask(id: string, patch: Partial<ReleaseTask>, label = `更新导出 ${id}`) {
    write(
      (draft) => {
        const task = draft.tasks.find((t) => t.id === id)
        if (task) Object.assign(task, patch)
      },
      { label },
    )
  }

  function logEvent(kind: ReleaseEventKind, message: string, terminal: 'A' | 'B' | 'S' | null = 'S') {
    write((draft) => pushEvent(draft, makeEvent(kind, message, terminal)), { label: '审计事件' })
  }

  return { initiate, sign, invalidate, refreeze, archiveReleased, enqueueTask, patchTask, logEvent }
}
