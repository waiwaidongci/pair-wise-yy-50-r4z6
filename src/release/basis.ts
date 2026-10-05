import type { Page, Position, Proof, SheetSpec } from '../stores/imposition'

export type Role = '拼版员' | '色彩管理' | '生产主管'
export type SignoffStep = '拼版' | '色彩' | '放行'
export type SignoffStatus = '待签核' | '待复核' | '已签核' | '已失效'
export type BatchStatus = '待复核' | '签核中' | '已放行' | '已失效'

export type Signoff = {
  step: SignoffStep
  label: string
  role: Role
  status: SignoffStatus
  signer: string | null
  signedAt: string | null
  basisHash: string | null
  basisDetail: string
}

export type BasisHashes = { layoutHash: string; colorHash: string; releaseHash: string }

export type FrozenBasis = {
  revision: string
  frozenAt: string
  layoutHash: string
  colorHash: string
  releaseHash: string
  sheet: SheetSpec
  pageCount: number
  positionCount: number
  proofCount: number
}

export type ReleaseBatch = {
  id: string
  revision: string
  status: BatchStatus
  version: number
  basis: BasisHashes
  frozen: FrozenBasis
  signoffs: Signoff[]
  exportIds: string[]
  createdAt: string
  releasedAt: string | null
  lastCommittedVersion: number
}

/** 确定性哈希：把依据结构化成字符串后取 32 位摘要，依据一变哈希即变。 */
export function hashBasis(input: unknown): string {
  const str = JSON.stringify(input)
  let h = 0
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) - h + str.charCodeAt(i)) | 0
  return `h${(h >>> 0).toString(16).padStart(8, '0')}`
}

/** 依据三类：版位（含纸张规格）、色差（打样结论）、整批（前两者串联）。 */
export function computeBasisHashes(pages: Page[], positions: Position[], sheet: SheetSpec, proofs: Proof[]): BasisHashes {
  const layoutHash = hashBasis({
    sheet: { width: sheet.width, height: sheet.height, bleed: sheet.bleed, safe: sheet.safe, gutter: sheet.gutter, binding: sheet.binding, grain: sheet.grain },
    pages: pages.map((p) => ({ no: p.pageNo, w: p.width, h: p.height, bleed: p.bleed })),
    positions: positions.map((p) => ({ id: p.id, no: p.pageNo, x: p.x, y: p.y, rot: p.rotation, front: p.front })),
  })
  const colorHash = hashBasis(
    proofs.map((p) => ({ id: p.id, round: p.round, sample: p.sample, dE: p.deltaE, decision: p.decision })),
  )
  const releaseHash = hashBasis({ layoutHash, colorHash })
  return { layoutHash, colorHash, releaseHash }
}

/**
 * 依据完整性：缺依据（未拼完、出血不足、无通过样张等）即归「待复核」，
 * 不能进入签核。
 */
export function computeCompleteness(pages: Page[], positions: Position[], sheet: SheetSpec, proofs: Proof[]) {
  const placed = new Set(positions.map((p) => p.pageNo))
  const allPlaced = pages.every((p) => placed.has(p.pageNo))
  const bleedOk = pages.every((p) => p.bleed >= sheet.bleed)
  const layoutOk = allPlaced && bleedOk
  const colorOk = proofs.some(
    (p) => p.decision === '通过' && p.deltaE > 0 && p.deltaE <= 2.0 && p.sample.trim().length > 0,
  )
  return { layoutOk, colorOk }
}

export function sameBasis(a: BasisHashes, b: BasisHashes) {
  return a.layoutHash === b.layoutHash && a.colorHash === b.colorHash && a.releaseHash === b.releaseHash
}

export const signoffDefs: { step: SignoffStep; label: string; role: Role; basisDetail: string }[] = [
  { step: '拼版', label: '拼版签核', role: '拼版员', basisDetail: '版位 · 出血 · 纸张规格' },
  { step: '色彩', label: '色彩签核', role: '色彩管理', basisDetail: '打样结论 · ΔE · 样张' },
  { step: '放行', label: '放行签核', role: '生产主管', basisDetail: '全批依据 · 前置签核' },
]

export function emptySignoffs(): Signoff[] {
  return signoffDefs.map((d) => ({ ...d, status: '待签核', signer: null, signedAt: null, basisHash: null }))
}
