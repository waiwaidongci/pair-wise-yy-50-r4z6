<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import { ROLE_LABEL, SLOT_LABEL, type ReleaseEventKind, type SlotId } from '../release/types'
import { useReleaseStore } from '../stores/release'

const release = useReleaseStore()
const batch = computed(() => release.state.activeBatch)
const b = computed(() => batch.value as NonNullable<typeof batch.value>)
const snapshot = computed(() => release.currentSnapshot())
const reasons = computed(() => release.currentReasons(snapshot.value))

const slots: { id: SlotId; desc: string }[] = [
  { id: 'imposition', desc: '确认版位、出血、折手与预检结论' },
  { id: 'color', desc: '确认样张、ΔE 与打样决定' },
  { id: 'production', desc: '确认纸张规格并放行进入导出' },
]

const eventMeta: Record<ReleaseEventKind, { icon: string; tone: string }> = {
  'batch-initiated': { icon: 'pi pi-send', tone: 'ok' },
  'signoff-accepted': { icon: 'pi pi-check-circle', tone: 'ok' },
  'signoff-conflict': { icon: 'pi pi-bolt', tone: 'bad' },
  'signoff-denied': { icon: 'pi pi-ban', tone: 'bad' },
  'basis-invalidated': { icon: 'pi pi-refresh', tone: 'warn' },
  'basis-refrozen': { icon: 'pi pi-snowflake', tone: 'info' },
  released: { icon: 'pi pi-unlock', tone: 'ok' },
  'export-invalidated': { icon: 'pi pi-download', tone: 'warn' },
  'export-queued': { icon: 'pi pi-inbox', tone: 'info' },
  'write-failed': { icon: 'pi pi-database', tone: 'bad' },
  'write-recovered': { icon: 'pi pi-history', tone: 'ok' },
  'startup-recovered': { icon: 'pi pi-shield', tone: 'ok' },
  'review-flagged': { icon: 'pi pi-flag', tone: 'warn' },
}

function formatTime(at: string) {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

const SLOT_REQUIRED: Record<SlotId, string> = { imposition: 'impositioner', color: 'colorist', production: 'supervisor' }
function roleMatch(slot: SlotId) {
  return SLOT_REQUIRED[slot] === release.operator.role
}
</script>

<template>
  <section class="panel release-panel">
    <div class="panel-head">
      <h3>放行批次</h3>
      <Tag v-if="batch" :value="batch.status" :severity="batch.status === '已放行' ? 'success' : batch.status === '依据已变更' ? 'danger' : batch.status === '待复核' ? 'warn' : 'info'" />
      <Tag v-else value="未发起" severity="secondary" />
    </div>

    <div class="release-body">
      <!-- 当前操作人 -->
      <div class="operator-strip">
        <span class="term" :class="release.operator.terminal">{{ release.operator.terminal }}</span>
        <strong>{{ release.operator.name }}</strong>
        <em>{{ ROLE_LABEL[release.operator.role] }}</em>
        <Tag v-if="batch" :value="`v${batch.version}`" severity="secondary" />
      </div>

      <!-- 无批次 -->
      <template v-if="!batch">
        <p class="hint">发起时冻结版位、出血与色差依据；之后三岗各自签核，任一处改动即作废旧签核与导出。</p>
        <ul v-if="reasons.length" class="reason-list">
          <li v-for="reason in reasons" :key="reason"><i class="pi pi-exclamation-triangle" />{{ reason }}</li>
        </ul>
        <div class="frozen-preview">
          <span>{{ snapshot.positionSummary }}</span>
          <span>{{ snapshot.bleedSummary }}</span>
          <span>色差依据：{{ snapshot.proof ? `${snapshot.proof.sample}（${snapshot.proof.decision} · ΔE ${snapshot.proof.deltaE}）` : '缺失' }}</span>
        </div>
        <Button label="发起放行批次（冻结依据）" icon="pi pi-send" fluid @click="release.initiateBatch" />
        <small class="muted">依据不足时不会报错，批次会归入「待复核」。</small>
      </template>

      <template v-else-if="batch">
        <!-- 待复核 -->
        <div v-if="batch.status === '待复核'" class="review-box">
          <strong><i class="pi pi-flag" /> 待复核：旧草稿缺少放行依据</strong>
          <p>{{ batch.reviewNote }}</p>
          <small>已冻结当前版位哈希与纸张规格作为复核基准；补齐依据后重新冻结，签核才开放。</small>
        </div>

        <!-- 冻结依据 -->
        <div class="frozen" :class="{ drift: b.status === '依据已变更' }">
          <div class="frozen-head"><strong>冻结依据</strong><Tag v-if="b.status === '依据已变更'" value="与现行不一致" severity="danger" /></div>
          <dl>
            <div><dt>拼版版本</dt><dd>{{ b.basis.revision }}</dd></div>
            <div><dt>版位快照</dt><dd><code>{{ b.basis.positionsHash }}</code></dd></div>
            <div><dt>纸张规格</dt><dd>{{ b.basis.sheetWidth }}×{{ b.basis.sheetHeight }}mm · {{ b.basis.binding }} · {{ b.basis.grain }}</dd></div>
            <div><dt>出血/安全区</dt><dd>≥ {{ b.basis.bleedRule }}mm / {{ b.basis.safeRule }}mm · 槽距 {{ b.basis.gutter }}mm</dd></div>
            <div><dt>色差依据</dt><dd>{{ b.basis.proof.sample }} · {{ b.basis.proof.decision }} · ΔE {{ b.basis.proof.deltaE }}</dd></div>
            <div><dt>依据哈希</dt><dd><code>版 {{ b.basis.positionsHash }} / 纸 {{ b.basis.paperHash }} / 色 {{ b.basis.colorHash }}</code></dd></div>
          </dl>
          <small class="muted">冻结于 {{ new Date(b.basis.frozenAt).toLocaleString('zh-CN', { hour12: false }) }} · {{ b.basis.frozenBy }}</small>
        </div>

        <div v-if="b.status === '依据已变更'" class="drift-banner">
          <i class="pi pi-warning-fill" />
          <div><strong>版位 / 纸张 / 打样决定已改动</strong><p>受影响签核已作废、未完成导出已失效并保留分片；核对后重新冻结，再由相关岗位重签。</p></div>
          <Button label="重新冻结当前依据" icon="pi pi-snowflake" size="small" @click="release.refreezeBatch" />
        </div>

        <!-- 签核槽位 -->
        <div v-if="b.signoffs.length" class="slots">
          <div v-for="slot in b.signoffs" :key="slot.slot" class="slot" :class="slot.status">
            <div class="slot-top">
              <strong>{{ SLOT_LABEL[slot.slot] }}</strong>
              <Tag :value="slot.status" :severity="slot.status === '已签核' ? 'success' : slot.status === '已作废' ? 'danger' : 'info'" />
            </div>
            <p>{{ slots.find((s) => s.id === slot.slot)?.desc }}</p>
            <small v-if="slot.status === '已签核'">
              <i class="pi pi-user" /> {{ slot.signedBy }} · 终端 {{ slot.terminal }} · 基于 v{{ slot.basisVersion }} · {{ formatTime(slot.signedAt ?? '') }}
            </small>
            <small v-else-if="slot.status === '已作废'" class="invalid-reason"><i class="pi pi-undo" /> 因「{{ slot.invalidatedBy }}」作废，需重签</small>
            <small v-else class="muted">仅限 {{ ROLE_LABEL[slot.requiredRole] }} · 基于 v{{ slot.basisVersion }}</small>
            <div class="slot-actions">
              <Button
                label="提交签核"
                icon="pi pi-check"
                size="small"
                :disabled="slot.status !== '待签核' || b.status !== '待签核'"
                :severity="roleMatch(slot.slot) ? 'success' : 'secondary'"
                @click="release.submitSign(slot.slot)"
              />
              <Button
                label="双终端同签"
                icon="pi pi-bolt"
                size="small"
                severity="warn"
                outlined
                :disabled="slot.status !== '待签核' || b.status !== '待签核'"
                @click="release.concurrentSubmit(slot.slot)"
              />
            </div>
          </div>
        </div>

        <div v-if="b.status === '已放行'" class="released-box">
          <i class="pi pi-unlock" />
          <div><strong>批次已放行</strong><p>三岗签核齐全，导出队列已解锁；导出任务锁定本批次 v{{ b.version }} 依据。</p></div>
        </div>

        <div class="batch-meta">
          <span>批次 {{ b.id }}</span>
          <span>发起 {{ b.initiatedBy }} · {{ new Date(b.initiatedAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
        </div>
      </template>

      <!-- 写盘故障演练 -->
      <div class="fault-box">
        <strong>写盘故障演练</strong>
        <div class="fault-actions">
          <Button size="small" label="注入：临时区失败" severity="warn" outlined @click="release.armFault('phase1')" />
          <Button size="small" label="注入：提交中途失败" severity="danger" outlined @click="release.armFault('phase2')" />
        </div>
        <small>下一次签核/发起即触发；系统从最后一次完整签核恢复并重试，不留半批。</small>
      </div>

      <div v-if="release.recoveryNotice" class="recovery" :class="{ bad: !release.recoveryNotice.recovered }">
        <i :class="release.recoveryNotice.recovered ? 'pi pi-history' : 'pi pi-database'" />
        <div>
          <strong>{{ release.recoveryNotice.recovered ? '已恢复并重试' : '写盘失败，等待重试' }}</strong>
          <p>{{ release.recoveryNotice.detail }}（{{ release.recoveryNotice.label }}）</p>
        </div>
        <i class="pi pi-times" @click="release.dismissNotice" />
      </div>
      <Button v-if="release.pendingRetry" size="small" label="手动重试上次提交" icon="pi pi-rotate-right" severity="danger" @click="release.retryPending" />
    </div>

    <!-- 审计 -->
    <div class="audit">
      <div class="panel-head"><h3>签核与放行审计</h3><span class="muted">{{ release.state.events.length }} 条</span></div>
      <div class="event-list">
        <div v-for="evt in release.state.events.slice(0, 14)" :key="evt.id" class="event" :class="eventMeta[evt.kind].tone">
          <i :class="eventMeta[evt.kind].icon" />
          <div><p>{{ evt.message }}</p><small>{{ formatTime(evt.at) }}<em v-if="evt.terminal && evt.terminal !== 'S'"> · 终端 {{ evt.terminal }}</em></small></div>
        </div>
        <div v-if="!release.state.events.length" class="muted empty-audit">尚无审计事件</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.release-body { display: grid; gap: 11px; padding: 13px 14px; }
.hint { margin: 0; color: #6f7e85; font-size: 11px; line-height: 1.6; }
.operator-strip { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border-radius: 8px; background: #f3f7f6; font-size: 12px; }
.operator-strip em { color: #809197; font-size: 10px; font-style: normal; }
.term { display: grid; width: 22px; height: 22px; place-items: center; border-radius: 50%; font-size: 10px; font-weight: 800; font-style: normal; }
.term.A { color: #10303a; background: #7fd4cf; }
.term.B { color: #3a2310; background: #f0b878; }
.operator-strip .p-tag { margin-left: auto; }
.reason-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.reason-list li { display: flex; gap: 7px; color: #9f5b2c; background: #fff6ec; border-radius: 6px; padding: 7px 9px; font-size: 11px; }
.frozen-preview { display: grid; gap: 5px; padding: 10px; border: 1px dashed #cbd7d9; border-radius: 8px; color: #5e7077; font-size: 10px; }
.review-box { display: grid; gap: 6px; padding: 11px; border: 1px solid #e2bd87; border-radius: 8px; background: #fff7eb; }
.review-box strong { display: flex; gap: 7px; align-items: center; color: #a3691f; font-size: 12px; }
.review-box p { margin: 0; color: #7a5c34; font-size: 11px; }
.review-box small { color: #98836a; }
.frozen { display: grid; gap: 8px; padding: 11px; border: 1px solid #d8e1e2; border-radius: 8px; background: #f8faf9; }
.frozen.drift { border-color: #d99a8d; background: #fdf4f2; }
.frozen-head { display: flex; align-items: center; justify-content: space-between; }
.frozen-head strong { font-size: 12px; }
.frozen dl { display: grid; gap: 5px; margin: 0; }
.frozen dl > div { display: grid; grid-template-columns: 64px 1fr; gap: 8px; font-size: 10px; }
.frozen dt { color: #8a989d; }
.frozen dd { margin: 0; color: #3e5158; }
.frozen code { font-size: 9px; word-break: break-all; }
.drift-banner { display: flex; align-items: center; gap: 10px; padding: 10px 11px; border-radius: 8px; color: #8c3324; background: #fdece8; font-size: 11px; }
.drift-banner > i { font-size: 18px; }
.drift-banner div { flex: 1; }
.drift-banner p { margin: 3px 0 0; color: #a0574a; font-size: 10px; line-height: 1.5; }
.slots { display: grid; gap: 9px; }
.slot { padding: 11px; border: 1px solid #dbe4e5; border-radius: 8px; }
.slot.已签核 { border-color: #9ccfb5; background: #f3faf6; }
.slot.已作废 { border-color: #e0a294; background: #fdf3f0; }
.slot-top { display: flex; align-items: center; justify-content: space-between; }
.slot-top strong { font-size: 12px; }
.slot p { margin: 6px 0; color: #72838a; font-size: 10px; }
.slot small { display: block; color: #4e666c; font-size: 10px; }
.slot small.invalid-reason { color: #a14a35; }
.slot-actions { display: flex; gap: 7px; margin-top: 9px; }
.released-box { display: flex; gap: 10px; align-items: center; padding: 12px; border-radius: 8px; color: #22604a; background: #eef8f2; }
.released-box > i { font-size: 22px; }
.released-box p { margin: 3px 0 0; color: #50796a; font-size: 10px; }
.batch-meta { display: flex; justify-content: space-between; gap: 8px; color: #94a2a8; font-size: 9px; }
.fault-box { display: grid; gap: 8px; padding: 10px 11px; border: 1px dashed #c9d4d6; border-radius: 8px; }
.fault-box > strong { font-size: 11px; color: #5c6e75; }
.fault-actions { display: flex; gap: 7px; flex-wrap: wrap; }
.fault-box small { color: #93a1a7; font-size: 9px; line-height: 1.5; }
.recovery { display: flex; gap: 9px; align-items: flex-start; padding: 10px; border-radius: 8px; background: #eef7f3; color: #2f6a54; font-size: 11px; }
.recovery.bad { background: #fdeeea; color: #a3452f; }
.recovery > i:first-child { margin-top: 2px; }
.recovery p { margin: 3px 0 0; font-size: 10px; color: inherit; opacity: .85; }
.recovery > i:last-child { margin-left: auto; cursor: pointer; }
.audit .event-list { max-height: 320px; overflow: auto; padding: 8px 12px 12px; }
.event { display: grid; grid-template-columns: 20px 1fr; gap: 8px; padding: 8px 0; border-bottom: 1px solid #f0f3f3; }
.event i { font-size: 13px; }
.event.ok i { color: #3b8a67; }
.event.bad i { color: #bd4a34; }
.event.warn i { color: #c4872f; }
.event.info i { color: #4b7b94; }
.event p { margin: 0; font-size: 11px; line-height: 1.5; }
.event small { color: #94a2a8; font-size: 9px; }
.empty-audit { padding: 14px 4px; font-size: 11px; }
.muted { color: #84949b; }
</style>
