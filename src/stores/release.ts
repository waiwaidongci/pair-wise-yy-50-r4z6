import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useImpositionStore } from './imposition'
import { useSessionStore } from './session'
import { releaseApi } from '../api/releaseApi'
import {
  type Role,
  type SignoffStep,
  type BatchStatus,
  type BasisHashes,
  type FrozenBasis,
  type ReleaseBatch,
  computeBasisHashes,
  computeCompleteness,
  sameBasis,
  signoffDefs,
} from '../release/basis'

export type { Role, SignoffStep, SignoffStatus, BatchStatus, Signoff, BasisHashes, FrozenBasis, ReleaseBatch } from '../release/basis'

export const useReleaseStore = defineStore('release', () => {
  const imposition = useImpositionStore()
  const session = useSessionStore()

  const saved = localStorage.getItem('print-release-v1')
  const restored = saved ? JSON.parse(saved) : null

  const batch = ref<ReleaseBatch | null>(restored?.batch ?? null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const errorCode = ref<string | null>(null)
  const info = ref<string | null>(null)
  const failNextCommit = ref(false)

  watch(batch, (v) => localStorage.setItem('print-release-v1', JSON.stringify({ batch: v })), { deep: true })

  const currentBasis = computed(() =>
    computeBasisHashes(imposition.pages, imposition.positions, imposition.sheet, imposition.proofs),
  )
  const completeness = computed(() =>
    computeCompleteness(imposition.pages, imposition.positions, imposition.sheet, imposition.proofs),
  )

  /** 批次放行即锁定拼版；失效则解锁以便修订。 */
  watch(
    () => batch.value?.status,
    (status) => {
      imposition.locked = status === '已放行'
    },
    { immediate: true },
  )

  /** 版位/纸张/打样结论一变，受影响签核与未完成导出立即失效重算。 */
  watch(currentBasis, (basis) => {
    if (!batch.value || sameBasis(basis, batch.value.basis)) return
    void invalidate(basis)
  })

  /** 刷新后用本地快照预热服务端权威状态。 */
  if (restored?.batch) {
    releaseApi.hydrate(restored.batch).then(({ data }) => {
      if (data.batch) batch.value = data.batch
    })
  }

  const releaseStatus = computed<BatchStatus | '无批次'>(() => batch.value?.status ?? '无批次')
  const isReleased = computed(() => batch.value?.status === '已放行')
  const pendingReviewCount = computed(() => batch.value?.signoffs.filter((s) => s.status === '待复核').length ?? 0)
  const invalidatedCount = computed(() => batch.value?.signoffs.filter((s) => s.status === '已失效').length ?? 0)
  const signedCount = computed(() => batch.value?.signoffs.filter((s) => s.status === '已签核').length ?? 0)

  function clearMessages() {
    error.value = null
    errorCode.value = null
    info.value = null
  }

  async function initiate() {
    loading.value = true
    clearMessages()
    try {
      const frozen: FrozenBasis = {
        revision: imposition.revision,
        frozenAt: new Date().toISOString(),
        ...currentBasis.value,
        sheet: { ...imposition.sheet },
        pageCount: imposition.pages.length,
        positionCount: imposition.positions.length,
        proofCount: imposition.proofs.length,
      }
      const { data } = await releaseApi.initiate({ frozen, revision: imposition.revision, completeness: completeness.value })
      batch.value = data.batch
      imposition.linkTasksToBatch(data.batch.id, data.batch.basis.releaseHash)
      info.value = '已发起放行批次，版位、出血与色差依据已冻结。'
    } catch (e) {
      error.value = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '发起批次失败'
    } finally {
      loading.value = false
    }
  }

  async function sign(step: SignoffStep) {
    if (!batch.value) return
    loading.value = true
    clearMessages()
    try {
      const { data } = await releaseApi.sign(batch.value.id, {
        step,
        role: session.role,
        signer: session.name,
        expectedVersion: batch.value.version,
        basis: currentBasis.value,
        completeness: completeness.value,
      })
      batch.value = data.batch
      info.value = `${signoffDefs.find((d) => d.step === step)?.label}已提交（批次 v${data.batch.version}）。`
    } catch (e) {
      const err = e as { response?: { status?: number; data?: { code?: string; message?: string } } }
      errorCode.value = err?.response?.data?.code ?? 'ERROR'
      error.value = err?.response?.data?.message ?? '签核失败'
      if (errorCode.value === 'WRITE_FAILED') info.value = '写盘被拒绝：未写入任何签核，已从最后一次完整签核恢复，可重试。'
    } finally {
      loading.value = false
    }
  }

  async function invalidate(basis: BasisHashes) {
    if (!batch.value) return
    loading.value = true
    clearMessages()
    try {
      const { data } = await releaseApi.invalidate(batch.value.id, basis, completeness.value)
      batch.value = data.batch
      imposition.invalidateUnfinishedTasks()
      info.value = '依据已变更：受影响的签核与未完成导出已失效，需重新签核。'
    } catch (e) {
      error.value = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '依据失效处理失败'
    } finally {
      loading.value = false
    }
  }

  /** 写盘失败后，从最后一次完整签核恢复并重试。 */
  async function retry() {
    if (!batch.value) return
    loading.value = true
    clearMessages()
    try {
      const { data } = await releaseApi.retry(batch.value.id)
      batch.value = data.batch
      info.value = `已从最后一次完整签核恢复（批次 v${data.recoveredTo}），可重新签核。`
    } catch (e) {
      error.value = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '恢复失败'
    } finally {
      loading.value = false
    }
  }

  /** 演示用：模拟另一终端抢先签核某环节（先到者占用）。 */
  async function simulateConflict(step: SignoffStep) {
    if (!batch.value) return
    loading.value = true
    clearMessages()
    try {
      const { data } = await releaseApi.conflict(batch.value.id, step, completeness.value)
      batch.value = data.batch
      info.value = `另一终端已抢先签核${signoffDefs.find((d) => d.step === step)?.label}（批次 v${data.batch.version}）。`
    } catch (e) {
      error.value = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '模拟冲突失败'
    } finally {
      loading.value = false
    }
  }

  async function setFailNextCommit(value: boolean) {
    failNextCommit.value = value
    await releaseApi.setFailNextCommit(value)
  }

  return {
    batch,
    loading,
    error,
    errorCode,
    info,
    failNextCommit,
    currentBasis,
    completeness,
    releaseStatus,
    isReleased,
    pendingReviewCount,
    invalidatedCount,
    signedCount,
    initiate,
    sign,
    retry,
    invalidate,
    simulateConflict,
    setFailNextCommit,
  }
})
