<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import ReleasePanel from '../components/ReleasePanel.vue'
import { useImpositionStore } from '../stores/imposition'
import { useReleaseStore } from '../stores/release'
import { SLOT_LABEL } from '../release/types'

const store = useImpositionStore()
const release = useReleaseStore()
const errors = computed(() => store.validations.filter((item) => item.severity === '错误').length)
const batch = computed(() => release.state.activeBatch)
const signedCount = computed(() => batch.value?.signoffs.filter((s) => s.status === '已签核').length ?? 0)
const invalidTasks = computed(() => release.state.tasks.filter((t) => t.status === '已失效'))
const runningTasks = computed(() => release.state.tasks.filter((t) => t.status === '排队中' || t.status === '生成中'))
const pendingProof = computed(() => store.proofs.find((proof) => proof.id === store.selectedProof))
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">PRINT PRODUCTION / 印刷生产</p>
        <h1>拼版预检与放行总览</h1>
        <p class="muted">拼版版本、打样结论与导出任务挂在同一个放行批次下：三岗签齐才放行，改动即作废重算。</p>
      </div>
      <div class="actions">
        <Button label="进入拼版工作区" icon="pi pi-th-large" outlined @click="$router.push('/imposition')" />
        <Button v-if="!batch" label="发起放行批次" icon="pi pi-send" @click="release.initiateBatch()" />
        <Button v-else label="查看导出队列" icon="pi pi-download" @click="$router.push('/exports')" />
      </div>
    </div>

    <!-- 总览与导出队列共用同一放行状态 -->
    <div class="status-banner" :class="batch?.status ?? 'empty'">
      <div class="status-main">
        <i :class="batch?.status === '已放行' ? 'pi pi-unlock' : batch?.status === '依据已变更' ? 'pi pi-warning-fill' : batch?.status === '待复核' ? 'pi pi-flag' : 'pi pi-shield'" />
        <div>
          <strong>{{ batch ? `放行状态：${batch.status}` : '尚未发起放行批次' }}</strong>
          <p v-if="batch">{{ batch.revision }} · 依据 v{{ batch.version }} · 发起人 {{ batch.initiatedBy }} · 批次 {{ batch.id }}</p>
          <p v-else>当前草稿 {{ store.revision }}，发起时将冻结版位、出血与色差依据。</p>
        </div>
      </div>
      <div class="status-side">
        <Tag v-if="batch" :value="batch.status" :severity="batch.status === '已放行' ? 'success' : batch.status === '依据已变更' ? 'danger' : batch.status === '待复核' ? 'warn' : 'info'" />
        <span v-if="batch?.signoffs.length">{{ signedCount }}/{{ batch.signoffs.length }} 岗已签</span>
      </div>
    </div>

    <div class="metric-grid">
      <article class="metric"><span>拼版版本</span><strong>{{ store.revision }}</strong><small>{{ store.positions.length }} 个版位 · {{ errors }} 项阻断错误</small></article>
      <article class="metric"><span>签核进度</span><strong :class="{ done: signedCount === 3 }">{{ signedCount }}/3</strong><small>{{ batch ? `依据 v${batch.version}` : '批次未发起' }}</small></article>
      <article class="metric"><span>色差依据</span><strong :class="{ bad: pendingProof?.decision !== '通过' }">{{ pendingProof?.decision ?? '—' }}</strong><small>{{ pendingProof ? `${pendingProof.sample} · ΔE ${pendingProof.deltaE}` : '未选择打样轮次' }}</small></article>
      <article class="metric"><span>失效导出</span><strong :class="{ bad: invalidTasks.length }">{{ invalidTasks.length }}</strong><small>{{ runningTasks.length }} 个任务进行中</small></article>
    </div>

    <div class="overview-grid">
      <div class="main-col">
        <section class="panel">
          <div class="panel-head"><h3>岗位签核</h3><Tag :value="batch ? `v${batch.version}` : '未冻结'" severity="secondary" /></div>
          <div class="sign-grid">
            <template v-if="batch?.signoffs.length">
              <article v-for="s in batch.signoffs" :key="s.slot" :class="s.status">
                <div class="sign-head"><strong>{{ SLOT_LABEL[s.slot] }}</strong><Tag :value="s.status" :severity="s.status === '已签核' ? 'success' : s.status === '已作废' ? 'danger' : 'info'" /></div>
                <p v-if="s.signedBy">{{ s.signedBy }}（终端 {{ s.terminal }}）已签 · v{{ s.basisVersion }}</p>
                <p v-else-if="s.status === '已作废'">因「{{ s.invalidatedBy }}」作废，重新冻结后重签</p>
                <p v-else>待对应岗位在任一终端提交</p>
              </article>
            </template>
            <div v-else class="no-slot muted">
              <i class="pi pi-inbox" />
              <p>{{ batch?.status === '待复核' ? '待复核批次不开放签核：请先补齐打样结论与预检错误，再重新冻结。' : '发起批次并冻结依据后，三个岗位签核槽位会同时出现在这里和导出页。' }}</p>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>导出队列（与本总览同一放行状态）</h3><Button label="打开导出页" text size="small" @click="$router.push('/exports')" /></div>
          <div class="task-rows">
            <article v-for="task in release.state.tasks" :key="task.id">
              <div class="task-row-head">
                <strong>{{ task.name }}</strong>
                <Tag :value="task.status" :severity="task.status === '已完成' ? 'success' : task.status === '已失效' ? 'danger' : task.status === '生成中' ? 'warn' : 'info'" />
              </div>
              <ProgressBar :value="task.progress" :showValue="false" :style="{ height: '6px' }" />
              <small>{{ task.id }} · {{ task.status === '已失效' ? task.invalidReason : `${task.progress}% · ${task.updatedAt}` }}<em v-if="task.basisVersion != null"> · 锁定 v{{ task.basisVersion }}</em></small>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>最近打样结论</h3><Button label="去打样审批" text size="small" @click="$router.push('/proofs')" /></div>
          <div class="proof-summary">
            <div v-for="proof in store.proofs.slice().reverse()" :key="proof.id" class="proof-row" :class="{ active: proof.id === store.selectedProof }">
              <div><strong>第 {{ proof.round }} 轮 · {{ proof.sample }}</strong><small>{{ proof.date }} · ΔE {{ proof.deltaE }} · {{ proof.owner }}</small></div>
              <Tag :value="proof.decision" :severity="proof.decision === '通过' ? 'success' : proof.decision === '退回' ? 'danger' : 'warn'" />
            </div>
          </div>
        </section>
      </div>

      <ReleasePanel />
    </div>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.status-banner { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; padding: 15px 18px; border-radius: 10px; border: 1px solid #dce3e4; background: white; box-shadow: 0 8px 24px rgba(34,57,64,.05); }
.status-banner.已放行 { border-color: #93c9ad; background: #f1faf5; }
.status-banner.依据已变更 { border-color: #df9d8f; background: #fdf1ee; }
.status-banner.待复核 { border-color: #e2bd87; background: #fff8ed; }
.status-main { display: flex; gap: 13px; align-items: center; }
.status-main > i { font-size: 26px; color: #4b7b94; }
.status-banner.已放行 .status-main > i { color: #3b8a67; }
.status-banner.依据已变更 .status-main > i { color: #bd4a34; }
.status-banner.待复核 .status-main > i { color: #c4872f; }
.status-main strong { font-size: 15px; }
.status-main p { margin: 4px 0 0; color: #74828a; font-size: 11px; }
.status-side { display: grid; gap: 7px; justify-items: end; color: #5f7076; font-size: 11px; }
.metric strong { font-size: 26px; }
.metric strong.done { color: #3b8a67; }
.metric strong.bad { color: #b84e35; }
.overview-grid { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
.main-col { display: grid; gap: 14px; }
.sign-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 14px; }
.sign-grid article { padding: 12px; border: 1px solid #dce6e7; border-radius: 8px; }
.sign-grid article.已签核 { border-color: #92c7ab; background: #f2faf6; }
.sign-grid article.已作废 { border-color: #e2a497; background: #fdf3f1; }
.sign-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.sign-head strong { font-size: 12px; }
.sign-grid p { margin: 8px 0 0; color: #6e7f86; font-size: 10px; line-height: 1.5; }
.no-slot { grid-column: 1 / -1; display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; }
.no-slot i { font-size: 20px; color: #93a6ac; }
.no-slot p { margin: 0; font-size: 11px; line-height: 1.6; }
.task-rows { display: grid; gap: 12px; padding: 14px 16px; }
.task-row-head { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 7px; }
.task-row-head strong { font-size: 12px; }
.task-rows small { display: block; margin-top: 6px; color: #7d898e; font-size: 10px; }
.task-rows em { color: #5d7b80; font-style: normal; }
.proof-summary { padding: 6px 16px 14px; }
.proof-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; border-bottom: 1px solid #edf1f1; }
.proof-row.active { margin: 0 -8px; padding: 11px 8px; background: #f4f9f8; border-radius: 7px; border-bottom-color: transparent; }
.proof-row strong, .proof-row small { display: block; }
.proof-row strong { font-size: 12px; }
.proof-row small { margin-top: 4px; color: #7a878d; font-size: 10px; }
@media (max-width: 1180px) { .overview-grid { grid-template-columns: 1fr; } .sign-grid { grid-template-columns: 1fr; } }
</style>
