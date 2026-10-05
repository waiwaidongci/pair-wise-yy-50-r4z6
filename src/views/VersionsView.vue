<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import ImpositionCanvas from '../components/ImpositionCanvas.vue'
import { useImpositionStore } from '../stores/imposition'
import { useReleaseStore } from '../stores/release'
import { SLOT_LABEL } from '../release/types'

const store = useImpositionStore()
const release = useReleaseStore()
const batch = computed(() => release.state.activeBatch)
const live = computed(() => release.currentSnapshot())

const rows = computed(() => {
  if (!batch.value) return []
  const b = batch.value
  return [
    {
      key: 'positions' as const,
      title: '版位与出血',
      frozen: b.basis.positionSummary,
      frozenHash: b.basis.positionsHash,
      liveHash: live.value.positionsHash,
      slots: ['imposition', 'color', 'production'] as const,
    },
    {
      key: 'paper' as const,
      title: '纸张规格',
      frozen: `${b.basis.sheetWidth}×${b.basis.sheetHeight}mm · 出血≥${b.basis.bleedRule} · ${b.basis.binding}`,
      frozenHash: b.basis.paperHash,
      liveHash: live.value.paperHash,
      slots: ['imposition', 'production'] as const,
    },
    {
      key: 'color' as const,
      title: '打样决定（色差依据）',
      frozen: `${b.basis.proof.sample} · ${b.basis.proof.decision} · ΔE ${b.basis.proof.deltaE}`,
      frozenHash: b.basis.colorHash,
      liveHash: live.value.colorHash,
      slots: ['color', 'production'] as const,
    },
  ]
})

const history = computed(() => release.state.history)
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">VERSION COMPARE / 版本对比</p><h1>冻结依据 vs 当前工作稿</h1><p class="muted">左侧为批次冻结时的版位，右侧为当前编辑稿；哈希漂移即标明哪些签核与导出已作废。</p></div>
      <div class="actions">
        <Button v-if="batch?.status === '依据已变更'" label="重新冻结并重签" icon="pi pi-snowflake" severity="warning" @click="release.refreezeBatch()" />
        <Button label="返回总览签核" icon="pi pi-check" @click="$router.push('/')" />
      </div>
    </div>

    <div v-if="!batch" class="panel empty-panel">
      <i class="pi pi-inbox" />
      <h3>尚无放行批次</h3>
      <p class="muted">发起批次后，这里会把冻结版本与当前工作稿并排对比，并给出哈希级差异。</p>
      <Button label="去发起批次" icon="pi pi-send" @click="$router.push('/')" />
    </div>

    <template v-else>
      <div class="compare-grid">
        <section class="panel">
          <div class="panel-head"><h3>冻结版位 · {{ batch.revision }} v{{ batch.version }}</h3><Tag :value="batch.status" :severity="batch.status === '已放行' ? 'success' : batch.status === '依据已变更' ? 'danger' : 'info'" /></div>
          <div class="canvas-box"><ImpositionCanvas :positions="store.positions" side="front" :zoom="38" :selected="null" :validations="[]" @update="() => {}" @select="() => {}" /></div>
          <div class="hash-foot muted">冻结哈希 {{ batch.basis.positionsHash }} · {{ new Date(batch.basis.frozenAt).toLocaleString('zh-CN', { hour12: false }) }}</div>
        </section>
        <section class="panel candidate">
          <div class="panel-head"><h3>当前工作稿 · {{ store.revision }}</h3><Tag :value="live.positionSummary" severity="secondary" /></div>
          <div class="canvas-box"><ImpositionCanvas :positions="store.positions" side="front" :zoom="38" :selected="null" :validations="store.validations" @update="() => {}" @select="() => {}" /></div>
          <div class="hash-foot muted">实时哈希 {{ live.positionsHash }}</div>
        </section>
      </div>

      <section class="panel change-panel">
        <div class="panel-head"><h3>依据漂移与签核影响面</h3><span class="muted">任何一项漂移都会立即作废对应签核与未完成导出</span></div>
        <div class="change-list">
          <article v-for="row in rows" :key="row.key" :class="{ drift: row.frozenHash !== row.liveHash }">
            <i :class="row.frozenHash !== row.liveHash ? 'pi pi-times-circle bad' : 'pi pi-check-circle ok'" />
            <div class="change-main">
              <strong>{{ row.title }}</strong>
              <p>冻结：{{ row.frozen }}</p>
              <div class="hashes"><code>{{ row.frozenHash }}</code><i class="pi pi-arrow-right" /><code :class="{ live: row.frozenHash !== row.liveHash }">{{ row.liveHash }}</code></div>
            </div>
            <div class="change-side">
              <Tag :value="row.frozenHash !== row.liveHash ? '已漂移' : '一致'" :severity="row.frozenHash !== row.liveHash ? 'danger' : 'success'" />
              <small v-if="row.frozenHash !== row.liveHash">作废：{{ row.slots.map((s) => SLOT_LABEL[s]).join('、') }}；未完成导出失效</small>
              <small v-else>签核在当前版本继续有效</small>
            </div>
          </article>
        </div>
      </section>

      <section v-if="history.length" class="panel history-panel">
        <div class="panel-head"><h3>已放行批次归档</h3><Tag :value="`${history.length} 批`" severity="success" /></div>
        <div class="history-list">
          <div v-for="item in history" :key="item.id"><strong>{{ item.id }}</strong><span>{{ item.revision }} · v{{ item.basisVersion }}</span><small>{{ new Date(item.releasedAt).toLocaleString('zh-CN', { hour12: false }) }} 放行</small></div>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; }
.compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
.candidate { border-color: #5d9693; }
.canvas-box { height: 440px; overflow: auto; padding: 12px; background: #35474d; }
.hash-foot { padding: 9px 14px; font-size: 10px; }
.empty-panel { display: grid; gap: 10px; justify-items: center; padding: 60px 20px; text-align: center; }
.empty-panel i { font-size: 34px; color: #9ab0b5; }
.change-panel { overflow: hidden; }
.change-list article { display: grid; grid-template-columns: 26px 1fr auto; gap: 12px; align-items: center; padding: 15px 16px; border-bottom: 1px solid #edf1f1; }
.change-list article.drift { background: #fdf4f2; }
.change-list i { font-size: 18px; }
.change-list i.ok { color: #3b8a67; }
.change-list i.bad { color: #bd4a34; }
.change-main strong { font-size: 12px; }
.change-main p { margin: 5px 0 7px; color: #6d7d83; font-size: 11px; }
.hashes { display: flex; align-items: center; gap: 8px; font-size: 10px; }
.hashes code { padding: 3px 6px; border-radius: 4px; background: #eef3f3; color: #4c6168; }
.hashes code.live { background: #fdece8; color: #a14a35; }
.hashes i { color: #93a2a8; }
.change-side { display: grid; gap: 7px; justify-items: end; max-width: 230px; }
.change-side small { color: #8c6258; font-size: 10px; text-align: right; line-height: 1.5; }
.history-panel { margin-top: 14px; }
.history-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; padding: 14px 16px; }
.history-list > div { display: grid; gap: 3px; padding: 10px 12px; border: 1px solid #e2e9ea; border-radius: 8px; }
.history-list strong { font-size: 11px; }
.history-list span { color: #49636b; font-size: 10px; }
.history-list small { color: #94a2a8; font-size: 9px; }
@media (max-width: 1000px) { .compare-grid { grid-template-columns: 1fr; } }
</style>
