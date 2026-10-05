// 原子写盘：primary 单条 JSON 整体提交；tmp/bak 兜底。
// 写盘失败时从最后一次完整签核锚点恢复并重试，绝不留下半批记录。

import type { ReleaseState } from './types'

const KEY = 'print-release-v2'
const TMP_KEY = `${KEY}.tmp`
const BAK_KEY = `${KEY}.bak`

export type FaultMode = 'none' | 'phase1' | 'phase2'

export type CommittedRecord = {
  state: ReleaseState
  label: string
  at: string
  /** 最后一次完整签核时间：恢复锚点 */
  anchor: string | null
  revision: number
}

export class DiskError extends Error {
  constructor(
    public phase: 1 | 2,
    message: string,
  ) {
    super(message)
    this.name = 'DiskError'
  }
}

let fault: FaultMode = 'none'

export function setFault(mode: FaultMode) {
  fault = mode
}

export function getFault() {
  return fault
}

function consumeFault(phase: 1 | 2): boolean {
  if (fault === 'none') return false
  if (fault === 'phase1' && phase === 1) {
    fault = 'none'
    return true
  }
  if (fault === 'phase2' && phase === 2) {
    fault = 'none'
    return true
  }
  return false
}

function safeParse(raw: string | null): CommittedRecord | null {
  if (!raw) return null
  try {
    const record = JSON.parse(raw) as CommittedRecord
    if (!record || !record.state || typeof record.revision !== 'number') return null
    return record
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string) {
  // 真实环境配额耗尽时 localStorage.setItem 会抛 QuotaExceededError
  localStorage.setItem(key, value)
}

/**
 * 两阶段提交：
 * 1. 写 tmp（失败：primary 不动，无半批）
 * 2. tmp 覆盖 primary（失败：tmp/bak 仍可恢复）
 */
export function commit(record: CommittedRecord): CommittedRecord {
  // 阶段 1：落临时区
  if (consumeFault(1)) {
    throw new DiskError(1, '磁盘不可用：临时区写入失败（模拟故障）')
  }
  writeRaw(TMP_KEY, JSON.stringify(record))

  // 阶段 2：提交主区（localStorage 单次 setItem 对事件循环是原子的）
  const previous = localStorage.getItem(KEY)
  if (consumeFault(2)) {
    // 制造“主区写到一半”的现场：tmp 完好、primary 损坏
    writeRaw(KEY, `{broken-${Date.now()}`)
    throw new DiskError(2, '写盘中途失败：主区记录不完整（模拟故障）')
  }
  writeRaw(KEY, JSON.stringify(record))
  // 提交成功：上一版完整记录进备份区，清理临时区（清理失败不影响一致性）
  try {
    if (previous && safeParse(previous)) writeRaw(BAK_KEY, previous)
    localStorage.removeItem(TMP_KEY)
  } catch {
    /* 清理容错：启动时会兜底扫描 */
  }
  return record
}

/**
 * 启动 / 故障后恢复：primary → tmp（阶段 2 崩溃的已提交数据）→ bak。
 * 校验完整签核锚点；任何半截 JSON 一律丢弃，不返回半批。
 */
export function restore(): { record: CommittedRecord | null; recoveredFrom: 'primary' | 'tmp' | 'bak' | null; cleaned: string[] } {
  const cleaned: string[] = []
  const primary = safeParse(localStorage.getItem(KEY))
  const tmp = safeParse(localStorage.getItem(TMP_KEY))
  const bak = safeParse(localStorage.getItem(BAK_KEY))

  // primary 损坏但 tmp 完好：阶段 2 崩溃，tmp 即最后一次完整提交
  if (!primary && tmp) {
    writeRaw(KEY, JSON.stringify(tmp))
    localStorage.removeItem(TMP_KEY)
    return { record: reconcile(tmp), recoveredFrom: 'tmp', cleaned }
  }
  if (primary && localStorage.getItem(KEY) && !safeParse(localStorage.getItem(KEY))) {
    // 不可能分支（safeParse 已判），保留以明确语义
  }
  if (!primary && !tmp && bak) {
    writeRaw(KEY, JSON.stringify(bak))
    localStorage.removeItem(BAK_KEY)
    return { record: reconcile(bak), recoveredFrom: 'bak', cleaned }
  }

  // 清理与主区不一致的残留临时文件，避免半批
  if (primary && tmp && tmp.revision < primary.revision) {
    localStorage.removeItem(TMP_KEY)
    cleaned.push(TMP_KEY)
  }
  if (primary) return { record: reconcile(primary), recoveredFrom: null, cleaned }
  return { record: null, recoveredFrom: null, cleaned }
}

/**
 * 锚点对齐：状态自称已放行但缺少三岗签核（理论上不该出现，防御性），
 * 回退到最后一次完整签核之前的一致状态。
 */
function reconcile(record: CommittedRecord): CommittedRecord {
  const batch = record.state.activeBatch
  if (batch && (batch.status === '已放行')) {
    const complete = batch.signoffs.length === 3 && batch.signoffs.every((s) => s.status === '已签核')
    if (!complete) {
      // 半批：丢弃这次不完整放行，回到待签核
      return {
        ...record,
        state: {
          ...record.state,
          activeBatch: {
            ...batch,
            status: '待签核',
            lastFullSignoffAt: null,
            signoffs: batch.signoffs.map((s) => (s.status === '已签核' && !s.signedAt ? { ...s, status: '待签核' as const, signedBy: null } : s)),
          },
        },
      }
    }
  }
  return record
}

export function clearStorage() {
  localStorage.removeItem(KEY)
  localStorage.removeItem(TMP_KEY)
  localStorage.removeItem(BAK_KEY)
}
