// 放行批次领域模型：岗位、冻结依据、签核、批次与审计事件

export type RoleId = 'impositioner' | 'colorist' | 'supervisor'
export type SlotId = 'imposition' | 'color' | 'production'

export const ROLE_LABEL: Record<RoleId, string> = {
  impositioner: '拼版员',
  colorist: '色彩管理',
  supervisor: '生产主管',
}

/** 签核槽位 -> 唯一可签的岗位 */
export const SLOT_ROLE: Record<SlotId, RoleId> = {
  imposition: 'impositioner',
  color: 'colorist',
  production: 'supervisor',
}

export const SLOT_LABEL: Record<SlotId, string> = {
  imposition: '拼版签核',
  color: '色彩签核',
  production: '生产放行',
}

/** 各类依据改动时，需要作废重签的槽位 */
export const BASIS_SLOT_IMPACT: Record<string, SlotId[]> = {
  positions: ['imposition', 'color', 'production'],
  paper: ['imposition', 'production'],
  color: ['color', 'production'],
}

export type Operator = {
  id: string
  name: string
  role: RoleId
  /** 模拟两个终端：A / B 两个工位会话 */
  terminal: 'A' | 'B'
}

/** 依据分类：版位 / 纸张规格 / 打样决定（色差依据） */
export type BasisKey = 'positions' | 'paper' | 'color'

export type ProofBasis = {
  proofId: string
  round: number
  sample: string
  decision: '通过' | '退回' | '待决定'
  deltaE: number
  decidedBy: string
  decidedAt: string
}

/** 发起批次时冻结的依据快照 */
export type FrozenBasis = {
  revision: string
  positionsHash: string
  paperHash: string
  colorHash: string
  sheetWidth: number
  sheetHeight: number
  bleedRule: number
  safeRule: number
  gutter: number
  binding: string
  grain: string
  proof: ProofBasis
  frozenAt: string
  frozenBy: string
  /** 依据摘要，供界面直接展示 */
  positionSummary: string
  bleedSummary: string
}

export type SignoffStatus = '待签核' | '已签核' | '已作废' | '版本冲突'

export type Signoff = {
  slot: SlotId
  requiredRole: RoleId
  status: SignoffStatus
  /** 该签核基于的批次 version；后到者用它检测版本冲突 */
  basisVersion: number
  signedBy: string | null
  signedRole: RoleId | null
  terminal: 'A' | 'B' | null
  signedAt: string | null
  note: string
  /** 被哪次依据改动作废 */
  invalidatedBy: string | null
}

export type BatchStatus =
  | '待复核' // 旧草稿缺依据，不能发起
  | '待签核' // 已发起，依据已冻结，等待岗位签核
  | '依据已变更' // 版位/纸张/打样改动，签核与导出失效，等待重新冻结
  | '已放行' // 三岗签齐
  | '已归档'

export type ReleaseBatch = {
  id: string
  revision: string
  status: BatchStatus
  version: number
  initiatedAt: string
  initiatedBy: string
  basis: FrozenBasis
  signoffs: Signoff[]
  /** 作废后重新冻结时记录 */
  refrozenAt: string | null
  refrozenBy: string | null
  /** 旧草稿迁移而来、缺依据的说明 */
  reviewNote: string | null
  /** 最近一次“完整签核”的时间，写盘失败恢复锚点 */
  lastFullSignoffAt: string | null
}

export type ReleaseEventKind =
  | 'batch-initiated'
  | 'signoff-accepted'
  | 'signoff-conflict'
  | 'signoff-denied'
  | 'basis-invalidated'
  | 'basis-refrozen'
  | 'released'
  | 'export-invalidated'
  | 'export-queued'
  | 'write-failed'
  | 'write-recovered'
  | 'startup-recovered'
  | 'review-flagged'

export type ReleaseEvent = {
  id: string
  at: string
  kind: ReleaseEventKind
  message: string
  terminal: 'A' | 'B' | 'S' | null
}

export type ReleaseState = {
  activeBatch: ReleaseBatch | null
  /** 已放行批次的精简归档 */
  history: { id: string; revision: string; releasedAt: string; basisVersion: number }[]
  events: ReleaseEvent[]
  /** 导出队列（总览与导出页读同一份，放行状态天然一致） */
  tasks: ReleaseTask[]
  /** 当前操作人（对应工位终端 A/B） */
  operatorId: string
  /** 最近一次写盘失败的待重试记录 */
  pendingRetry: { label: string; at: string; detail: string } | null
  bootstrapped: boolean
  recoveredAtStartup: string | null
}

export type ReleaseTask = {
  id: string
  name: string
  progress: number
  status: '排队中' | '生成中' | '已完成' | '已中断' | '已失效'
  updatedAt: string
  resumable: boolean
  batchId: string | null
  basisVersion: number | null
  /** 失效原因，随依据变更记录 */
  invalidReason: string | null
}

export class ReleaseError extends Error {
  constructor(
    public code: 403 | 409,
    message: string,
    public detail?: { slot?: SlotId; currentVersion?: number; winner?: string },
  ) {
    super(message)
    this.name = 'ReleaseError'
  }
}
