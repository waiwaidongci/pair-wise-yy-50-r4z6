<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import { useReleaseStore, type BatchStatus, type SignoffStatus, type SignoffStep } from '../stores/release'
import { useSessionStore } from '../stores/session'

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const release = useReleaseStore()
const session = useSessionStore()

const batch = computed(() => release.batch)

const batchSeverity: Record<BatchStatus | '无批次', 'success' | 'danger' | 'warn' | 'info' | 'secondary'> = {
  已放行: 'success',
  已失效: 'danger',
  待复核: 'warn',
  签核中: 'info',
  无批次: 'secondary',
}

const signoffSeverity: Record<SignoffStatus, 'success' | 'danger' | 'warn' | 'info'> = {
  已签核: 'success',
  已失效: 'danger',
  待复核: 'warn',
  待签核: 'info',
}

function canSign(step: SignoffStep, role: string) {
  return role === session.role
}
</script>

<template>
  <section class="panel release-panel">
    <div class="panel-head">
      <h3>放行状态</h3>
      <Tag :value="release.releaseStatus" :severity="batchSeverity[release.releaseStatus]" />
    </div>

    <!-- 无批次 -->
    <div v-if="!batch" class="empty-batch">
      <p>尚未发起放行批次。发起时将冻结版位、出血与色差依据，进入岗位签核流程。</p>
      <Button v-if="!compact" label="发起放行批次" icon="pi pi-send" :loading="release.loading" @click="release.initiate" />
      <span v-else class="muted">请前往生产总览发起批次。</span>
    </div>

    <template v-else>
      <div class="batch-meta">
        <span><i class="pi pi-id-card" />{{ batch.id }}</span>
        <span><i class="pi pi-tag" />拼版版本 {{ batch.revision }}</span>
        <span><i class="pi pi-history" />批次 v{{ batch.version }}</span>
        <span><i class="pi pi-clock" />冻结于 {{ new Date(batch.frozen.frozenAt).toLocaleTimeString('zh-CN') }}</span>
      </div>

      <div class="frozen-basis">
        <div><i class="pi pi-th-large" />版位 <strong>{{ batch.frozen.positionCount }}</strong> 个</div>
        <div><i class="pi pi-file" />页面 <strong>{{ batch.frozen.pageCount }}</strong> P</div>
        <div><i class="pi pi-palette" />打样 <strong>{{ batch.frozen.proofCount }}</strong> 轮</div>
        <div><i class="pi pi-expand" />纸张 <strong>{{ batch.frozen.sheet.width }}×{{ batch.frozen.sheet.height }}mm</strong></div>
      </div>

      <!-- 岗位切换 -->
      <div class="role-switch">
        <span class="muted">当前岗位</span>
        <SelectButton v-model="session.role" :options="session.roleOptions" optionLabel="label" optionValue="value" />
        <strong class="role-name">{{ session.name }}</strong>
      </div>

      <!-- 签核环节 -->
      <div class="signoff-list">
        <article v-for="so in batch.signoffs" :key="so.step" :class="['signoff-row', so.status]">
          <div class="signoff-main">
            <div class="signoff-title">
              <strong>{{ so.label }}</strong>
              <Tag :value="so.role" severity="secondary" />
              <Tag :value="so.status" :severity="signoffSeverity[so.status]" />
            </div>
            <p class="signoff-detail">{{ so.basisDetail }}</p>
            <p v-if="so.status === '已签核'" class="signer">
              <i class="pi pi-check-circle" />{{ so.signer }} · {{ new Date(so.signedAt!).toLocaleString('zh-CN') }}
            </p>
            <p v-else-if="so.status === '已失效'" class="signer invalid">
              <i class="pi pi-exclamation-triangle" />依据已变更，签核失效，需重新签核
            </p>
            <p v-else-if="so.status === '待复核'" class="signer review">
              <i class="pi pi-question-circle" />缺依据（待复核）：补齐版位/出血/色差依据后可签核
            </p>
          </div>
          <div class="signoff-actions">
            <Button
              v-if="so.status === '待签核' || so.status === '已失效'"
              :label="canSign(so.step, so.role) ? '签核' : `需${so.role}签核`"
              :icon="canSign(so.step, so.role) ? 'pi pi-check' : 'pi pi-lock'"
              size="small"
              :severity="canSign(so.step, so.role) ? 'primary' : 'secondary'"
              :loading="release.loading"
              @click="release.sign(so.step)"
            />
            <Button
              v-if="!compact && so.status === '待签核'"
              label="模拟另一终端抢先"
              icon="pi pi-users"
              size="small"
              text
              @click="release.simulateConflict(so.step)"
            />
          </div>
        </article>
      </div>

      <!-- 演示：写盘失败注入 + 恢复 -->
      <div v-if="!compact" class="recovery-box">
        <label class="fail-toggle">
          <input type="checkbox" :checked="release.failNextCommit" @change="($event.target as HTMLInputElement).checked ? release.setFailNextCommit(true) : release.setFailNextCommit(false)" />
          模拟下次写盘失败（验证原子写盘与恢复）
        </label>
        <Button
          v-if="release.errorCode === 'WRITE_FAILED'"
          label="从最后一次完整签核恢复并重试"
          icon="pi pi-replay"
          size="small"
          severity="warn"
          :loading="release.loading"
          @click="release.retry"
        />
      </div>

      <Message v-if="release.error" severity="error" :closable="false" class="msg">{{ release.error }}</Message>
      <Message v-else-if="release.info" severity="info" :closable="false" class="msg">{{ release.info }}</Message>
    </template>
  </section>
</template>

<style scoped>
.release-panel { overflow: hidden; }
.empty-batch { padding: 18px; display: grid; gap: 12px; justify-items: start; }
.empty-batch p { margin: 0; color: #6b7b80; font-size: 12px; line-height: 1.6; }
.batch-meta { display: flex; flex-wrap: wrap; gap: 14px; padding: 12px 16px 0; color: #5d7077; font-size: 11px; }
.batch-meta span { display: inline-flex; align-items: center; gap: 5px; }
.batch-meta i { color: #8a9aa0; }
.frozen-basis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 12px 16px; }
.frozen-basis > div { display: grid; gap: 3px; padding: 9px; border: 1px solid #e7ebec; border-radius: 7px; color: #7a878d; font-size: 10px; }
.frozen-basis strong { color: #2c4a52; font-size: 15px; }
.role-switch { display: flex; align-items: center; gap: 10px; padding: 4px 16px 12px; }
.role-name { color: #337b79; font-size: 12px; }
.signoff-list { display: grid; gap: 8px; padding: 0 16px 12px; }
.signoff-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid #e7ebec; border-radius: 8px; }
.signoff-row.已签核 { background: #f1f8f5; border-color: #cfe6dc; }
.signoff-row.已失效 { background: #fdf3ef; border-color: #f0c9bd; }
.signoff-row.待复核 { background: #fdf8ec; border-color: #ecd9ae; }
.signoff-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.signoff-detail { margin: 5px 0 0; color: #7c898e; font-size: 10px; }
.signer { display: flex; align-items: center; gap: 5px; margin: 6px 0 0; color: #3b8a67; font-size: 11px; }
.signer.invalid { color: #bd4a34; }
.signer.review { color: #b07a1f; }
.signoff-actions { display: flex; gap: 6px; flex-shrink: 0; }
.recovery-box { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 16px; border-top: 1px dashed #d5dddd; }
.fail-toggle { display: flex; align-items: center; gap: 7px; color: #6b7b80; font-size: 11px; cursor: pointer; }
.msg { margin: 0 16px 14px; }
@media (max-width: 640px) { .frozen-basis { grid-template-columns: repeat(2, 1fr); } .signoff-row { flex-direction: column; align-items: stretch; } }
</style>
