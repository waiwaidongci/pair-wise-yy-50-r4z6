import axios, { type AxiosAdapter } from 'axios'
import {
  type ReleaseBatch,
  type Role,
  type Signoff,
  type BatchStatus,
  type BasisHashes,
  type FrozenBasis,
  emptySignoffs,
} from '../release/basis'

/**
 * 放行批次服务端（模拟）。
 * 权威状态保存在内存中，负责：
 * - 发起时冻结版位、出血与色差依据
 * - 签核的乐观并发控制（先到者占用，后到者遇版本冲突）
 * - 岗位权限校验（越权拒绝）
 * - 原子化写盘：失败时回滚到最后一次完整签核，不留半批记录
 * - 依据变更后的签核失效重算
 */

type Completeness = { layoutOk: boolean; colorOk: boolean }

let batch: ReleaseBatch | null = null
let lastCommitted: ReleaseBatch | null = null
let failNextCommit = false
let seq = 0

function now() {
  return new Date().toISOString()
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function apiError(status: number, code: string, message: string): Promise<never> {
  return Promise.reject({ response: { status, data: { code, message } }, config: {} })
}

function computeBatchStatus(b: ReleaseBatch): BatchStatus {
  if (b.signoffs.some((s) => s.status === '已失效')) return '已失效'
  if (b.signoffs.every((s) => s.status === '已签核')) return '已放行'
  if (b.signoffs.some((s) => s.status === '待复核')) return '待复核'
  return '签核中'
}

/** 依据变更后重算签核状态：已签核但依据对不上 → 已失效；已失效保持到重新签核；其余按完整性归待复核/待签核。 */
function recomputeSignoffs(b: ReleaseBatch, completeness: Completeness): ReleaseBatch {
  const next = clone(b)
  for (const so of next.signoffs) {
    const currentHash = so.step === '拼版' ? next.basis.layoutHash : so.step === '色彩' ? next.basis.colorHash : next.basis.releaseHash
    if (so.status === '已签核') {
      so.status = so.basisHash === currentHash ? '已签核' : '已失效'
    } else if (so.status === '已失效') {
      // 已失效的签核必须重新签核，不因完整性恢复而自动回到待签核
    } else {
      const prereq =
        so.step === '放行'
          ? next.signoffs[0].status === '已签核' && next.signoffs[1].status === '已签核'
          : true
      const complete = so.step === '拼版' ? completeness.layoutOk : so.step === '色彩' ? completeness.colorOk : completeness.layoutOk && completeness.colorOk && prereq
      so.status = complete ? '待签核' : '待复核'
    }
  }
  next.status = computeBatchStatus(next)
  return next
}

/**
 * 原子提交：写盘失败时丢弃本次变更，权威状态保持在最后一次完整签核，
 * 因此不会留下半批记录。
 */
function commit(next: ReleaseBatch): ReleaseBatch {
  if (failNextCommit) {
    failNextCommit = false
    throw {
      response: {
        status: 500,
        data: { code: 'WRITE_FAILED', message: '写盘失败：事务未提交，已从最后一次完整签核恢复，未留下半批记录。' },
      },
      config: {},
    }
  }
  batch = clone(next)
  lastCommitted = clone(next)
  return clone(batch)
}

function currentHashFor(b: ReleaseBatch, step: Signoff['step']): string {
  return step === '拼版' ? b.basis.layoutHash : step === '色彩' ? b.basis.colorHash : b.basis.releaseHash
}

function buildBatch(frozen: FrozenBasis, revision: string, completeness: Completeness): ReleaseBatch {
  const signoffs = emptySignoffs()
  const b: ReleaseBatch = {
    id: `RLS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String((seq += 1)).padStart(2, '0')}`,
    revision,
    status: '签核中',
    version: 1,
    basis: { layoutHash: frozen.layoutHash, colorHash: frozen.colorHash, releaseHash: frozen.releaseHash },
    frozen,
    signoffs,
    exportIds: [],
    createdAt: now(),
    releasedAt: null,
    lastCommittedVersion: 1,
  }
  return recomputeSignoffs(b, completeness)
}

const adapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => setTimeout(resolve, 150))
  const url = config.url ?? ''
  const method = config.method ?? 'get'
  const body = config.data ? JSON.parse(config.data) : {}

  // 当前批次
  if (url === '/api/release-batches/current' && method === 'get') {
    return { data: { batch: clone(batch) }, status: 200, statusText: 'OK', headers: {}, config }
  }

  // 发起放行批次（冻结依据）
  if (url === '/api/release-batches' && method === 'post') {
    const { frozen, revision, completeness } = body as { frozen: FrozenBasis; revision: string; completeness: Completeness }
    if (batch) return apiError(409, 'BATCH_EXISTS', '已存在进行中的放行批次。')
    const next = buildBatch(frozen, revision, completeness)
    batch = commit(next)
    return { data: { batch: clone(batch) }, status: 200, statusText: 'OK', headers: {}, config }
  }

  // 预热（刷新后恢复服务端权威状态）
  if (url === '/api/release-batches/hydrate' && method === 'post') {
    const { batch: restored } = body as { batch: ReleaseBatch | null }
    if (restored) {
      batch = clone(restored)
      lastCommitted = clone(restored)
    }
    return { data: { batch: clone(batch) }, status: 200, statusText: 'OK', headers: {}, config }
  }

  // 写盘失败开关
  if (url === '/api/release-batches/fail-flag' && method === 'post') {
    failNextCommit = Boolean(body.value)
    return { data: { failNextCommit }, status: 200, statusText: 'OK', headers: {}, config }
  }

  const signMatch = url.match(/^\/api\/release-batches\/([^/]+)\/sign$/)
  if (signMatch && method === 'post') {
    const id = signMatch[1]
    if (!batch || batch.id !== id) return apiError(404, 'NOT_FOUND', '放行批次不存在。')
    const { step, role, signer, expectedVersion, basis, completeness } = body as {
      step: Signoff['step']
      role: Role
      signer: string
      expectedVersion: number
      basis: BasisHashes
      completeness: Completeness
    }
    if (batch.status === '已放行') return apiError(409, 'BATCH_RELEASED', '批次已放行，无需重复签核。')
    const target = batch.signoffs.find((s) => s.step === step)
    if (!target) return apiError(404, 'NOT_FOUND', '签核环节不存在。')

    // 岗位权限校验
    if (target.role !== role) {
      return apiError(403, 'ROLE_FORBIDDEN', `岗位权限不足：「${target.label}」需由「${target.role}」签核，当前岗位为「${role}」，已拒绝。`)
    }
    // 依据必须与冻结/最新依据一致，否则说明版位或打样结论已改动
    if (basis && currentHashFor(batch, step) !== (step === '拼版' ? basis.layoutHash : step === '色彩' ? basis.colorHash : basis.releaseHash)) {
      return apiError(409, 'BASIS_INVALID', '依据已变更：该签核所依据的版位/打样结论已失效，请重新发起批次。')
    }
    // 乐观并发：先到者占用
    if (batch.version !== expectedVersion) {
      return apiError(409, 'VERSION_CONFLICT', `版本冲突：批次已被其他终端更新至 v${batch.version}（先到者占用），请刷新后重新签核。`)
    }
    if (target.status === '已签核') {
      return apiError(409, 'STEP_OCCUPIED', `先到者占用：「${target.label}」已由 ${target.signer} 签核。`)
    }
    if (target.status === '已失效') {
      return apiError(409, 'STEP_INVALID', '该签核已失效，请重新发起批次后再签核。')
    }
    if (target.status === '待复核') {
      return apiError(409, 'STEP_PENDING_REVIEW', '该环节依据不足（待复核），补齐依据后方可签核。')
    }
    if (step === '放行') {
      const layoutSigned = batch.signoffs[0].status === '已签核'
      const colorSigned = batch.signoffs[1].status === '已签核'
      if (!layoutSigned || !colorSigned) return apiError(409, 'PREREQ_MISSING', '前置签核未完成：拼版与色彩签核完成后方可放行。')
    }

    const next = clone(batch)
    const so = next.signoffs.find((s) => s.step === step)!
    so.status = '已签核'
    so.signer = signer
    so.signedAt = now()
    so.basisHash = currentHashFor(next, step)
    next.version += 1
    // 重算非签核环节资格（如放行前置条件满足后由待复核转为待签核）
    const recomputed = recomputeSignoffs(next, completeness)
    if (recomputed.status === '已放行') recomputed.releasedAt = now()
    try {
      batch = commit(recomputed)
    } catch (e) {
      return Promise.reject(e)
    }
    return { data: { batch: clone(batch) }, status: 200, statusText: 'OK', headers: {}, config }
  }

  const invalidateMatch = url.match(/^\/api\/release-batches\/([^/]+)\/invalidate$/)
  if (invalidateMatch && method === 'post') {
    const id = invalidateMatch[1]
    if (!batch || batch.id !== id) return apiError(404, 'NOT_FOUND', '放行批次不存在。')
    const { basis, completeness } = body as { basis: BasisHashes; completeness: Completeness }
    const next = clone(batch)
    next.basis = { ...basis }
    next.version += 1
    const recomputed = recomputeSignoffs(next, completeness)
    batch = commit(recomputed)
    return { data: { batch: clone(batch) }, status: 200, statusText: 'OK', headers: {}, config }
  }

  const retryMatch = url.match(/^\/api\/release-batches\/([^/]+)\/retry$/)
  if (retryMatch && method === 'post') {
    const id = retryMatch[1]
    if (!batch || batch.id !== id) return apiError(404, 'NOT_FOUND', '放行批次不存在。')
    if (!lastCommitted) return apiError(404, 'NOT_FOUND', '无已提交批次可恢复。')
    // 从最后一次完整签核恢复
    batch = clone(lastCommitted)
    const recoveredTo = batch.version
    return { data: { batch: clone(batch), recoveredTo }, status: 200, statusText: 'OK', headers: {}, config }
  }

  const conflictMatch = url.match(/^\/api\/release-batches\/([^/]+)\/conflict$/)
  if (conflictMatch && method === 'post') {
    const id = conflictMatch[1]
    if (!batch || batch.id !== id) return apiError(404, 'NOT_FOUND', '放行批次不存在。')
    const { step, completeness } = body as { step: Signoff['step']; completeness?: Completeness }
    const next = clone(batch)
    const so = next.signoffs.find((s) => s.step === step)
    if (so && so.status !== '已签核') {
      so.status = '已签核'
      so.signer = `另一终端 · ${so.role}`
      so.signedAt = now()
      so.basisHash = currentHashFor(next, step)
      next.version += 1
      const recomputed = recomputeSignoffs(next, completeness ?? { layoutOk: true, colorOk: true })
      if (recomputed.status === '已放行') recomputed.releasedAt = now()
      batch = commit(recomputed)
    }
    return { data: { batch: clone(batch) }, status: 200, statusText: 'OK', headers: {}, config }
  }

  return { data: null, status: 404, statusText: 'Not Found', headers: {}, config }
}

const client = axios.create({ adapter })

export const releaseApi = {
  current: () => client.get<{ batch: ReleaseBatch | null }>('/api/release-batches/current'),
  initiate: (payload: { frozen: FrozenBasis; revision: string; completeness: Completeness }) =>
    client.post<{ batch: ReleaseBatch }>('/api/release-batches', payload),
  hydrate: (batch: ReleaseBatch) => client.post<{ batch: ReleaseBatch | null }>('/api/release-batches/hydrate', { batch }),
  setFailNextCommit: (value: boolean) => client.post('/api/release-batches/fail-flag', { value }),
  sign: (
    id: string,
    payload: { step: Signoff['step']; role: Role; signer: string; expectedVersion: number; basis: BasisHashes; completeness: Completeness },
  ) => client.post<{ batch: ReleaseBatch }>(`/api/release-batches/${id}/sign`, payload),
  invalidate: (id: string, basis: BasisHashes, completeness: Completeness) =>
    client.post<{ batch: ReleaseBatch }>(`/api/release-batches/${id}/invalidate`, { basis, completeness }),
  retry: (id: string) => client.post<{ batch: ReleaseBatch; recoveredTo: number }>(`/api/release-batches/${id}/retry`),
  conflict: (id: string, step: Signoff['step'], completeness?: Completeness) =>
    client.post<{ batch: ReleaseBatch }>(`/api/release-batches/${id}/conflict`, { step, completeness }),
  /** 测试用：清空服务端权威状态。 */
  __reset: () => {
    batch = null
    lastCommitted = null
    failNextCommit = false
    seq = 0
  },
}
