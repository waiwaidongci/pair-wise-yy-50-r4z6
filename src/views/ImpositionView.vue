<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import SelectButton from 'primevue/selectbutton'
import Slider from 'primevue/slider'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import ImpositionCanvas from '../components/ImpositionCanvas.vue'
import { useImpositionStore } from '../stores/imposition'
import { useReleaseStore } from '../stores/release'

const store = useImpositionStore()
const release = useReleaseStore()
const sideOptions = [
  { label: '正面', value: 'front' },
  { label: '反面', value: 'back' },
]
const selected = computed(() => store.positions.find((item) => item.id === store.selectedPosition))
const selectedPage = computed(() => store.pages.find((page) => page.pageNo === selected.value?.pageNo))
const activeValidations = computed(() => store.validations.filter((item) => !item.pageNo || item.pageNo === selected.value?.pageNo || sideContains(item.pageNo)))
const batch = computed(() => release.state.activeBatch)
const bindingOptions = ['骑马订', '胶订', '锁线订', '铁圈装']
const grainOptions = ['纵向', '横向']

function sideContains(pageNo?: number) {
  if (!pageNo) return true
  return store.positions.some((position) => position.pageNo === pageNo && position.front === (store.side === 'front'))
}

function locate(pageNo?: number) {
  const position = store.positions.find((item) => item.pageNo === pageNo)
  if (position) {
    store.selectedPosition = position.id
    store.side = position.front ? 'front' : 'back'
  }
}

function fixBleed(pageNo?: number) {
  if (!pageNo) return
  store.updatePage(pageNo, { bleed: store.paper.bleed })
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">IMPOSITION / 拼版工作区</p><h1>Canvas 版位编排与预检</h1><p class="muted">拖拽版位、调整出血或纸张规格；若已发起批次，这些改动会立即作废相关签核与未完成导出。</p></div>
      <div class="actions">
        <Button label="另存拼版版本" icon="pi pi-save" outlined @click="store.bumpRevision()" />
        <Button label="去放行签核" icon="pi pi-send" @click="$router.push('/')" />
      </div>
    </div>

    <Message v-if="batch?.status === '依据已变更'" severity="error" :closable="false" class="mb-3">
      批次 {{ batch.id }} 的依据已改动（v{{ batch.version }}）：受影响签核已作废、未完成导出已失效。请到总览重新冻结并重签。
    </Message>
    <Message v-else-if="batch" severity="warn" :closable="false" class="mb-3">
      批次已冻结版位/出血/色差依据 v{{ batch.version }}（{{ batch.status }}）。画布仍可编辑，但保存即触发作废重算。
    </Message>
    <Message v-if="store.validations.length" severity="warn" :closable="false" class="mb-3">
      当前版本有 {{ store.validations.filter((item) => item.severity === '错误').length }} 个阻断错误和 {{ store.validations.filter((item) => item.severity === '警告').length }} 个警告。
    </Message>

    <div class="toolbar panel">
      <SelectButton v-model="store.side" :options="sideOptions" optionLabel="label" optionValue="value" />
      <span class="muted">缩放 {{ store.zoom }}%</span>
      <Slider v-model="store.zoom" :min="35" :max="100" :step="5" style="width:150px" />
      <span class="paper-spec">{{ store.paper.width }} × {{ store.paper.height }}mm · 出血 {{ store.paper.bleed }}mm · 安全区 {{ store.paper.safe }}mm · {{ store.revision }}</span>
      <Tag v-if="batch" :value="`冻结 v${batch.version} · ${batch.status}`" :severity="batch.status === '依据已变更' ? 'danger' : batch.status === '已放行' ? 'success' : 'info'" />
    </div>

    <div class="imposition-grid">
      <aside class="panel pages-panel">
        <div class="panel-head"><h3>页面文件</h3><Tag :value="`${store.pages.length}P`" /></div>
        <div class="page-list">
          <button v-for="page in store.pages" :key="page.pageNo" :disabled="store.positions.some((item) => item.pageNo === page.pageNo && item.front === (store.side === 'front'))" @click="store.addPosition(page.pageNo)">
            <div class="thumb"><span>P{{ page.pageNo }}</span><i /></div>
            <div><strong>{{ page.name }}</strong><small>{{ page.width }}×{{ page.height }} · 出血 {{ page.bleed }}mm</small></div>
            <i class="pi pi-plus" />
          </button>
        </div>
      </aside>

      <section class="panel canvas-panel">
        <div class="panel-head"><h3>{{ store.side === 'front' ? '正面版式' : '反面版式' }}</h3><span class="muted">拖动页面 · 点击选择</span></div>
        <div class="canvas-scroll">
          <ImpositionCanvas
            :positions="store.positions"
            :side="store.side"
            :zoom="store.zoom"
            :selected="store.selectedPosition"
            :validations="store.validations"
            @select="store.selectedPosition = $event"
            @update="store.updatePosition"
          />
        </div>
      </section>

      <aside class="right-panel">
        <section class="panel">
          <div class="panel-head"><h3>版位/出血属性</h3><Tag v-if="selected" :value="selected.id" /></div>
          <div v-if="selected" class="properties">
            <label>页面<select :value="selected.pageNo" @change="store.updatePosition(selected.id, { pageNo: Number(($event.target as HTMLSelectElement).value) })"><option v-for="page in store.pages" :key="page.pageNo" :value="page.pageNo">P{{ page.pageNo }} · {{ page.name }}</option></select></label>
            <div class="pair"><label>X<input type="number" :value="selected.x" @change="store.updatePosition(selected.id, { x: Number(($event.target as HTMLInputElement).value) })" /></label><label>Y<input type="number" :value="selected.y" @change="store.updatePosition(selected.id, { y: Number(($event.target as HTMLInputElement).value) })" /></label></div>
            <label>旋转方向<select :value="selected.rotation" @change="store.updatePosition(selected.id, { rotation: Number(($event.target as HTMLSelectElement).value) })"><option :value="0">0°</option><option :value="90">顺时针 90°</option><option :value="180">倒置 180°</option><option :value="270">顺时针 270°</option></select></label>
            <label v-if="selectedPage">页面出血（mm）<input type="number" min="0" max="10" step="0.5" :value="selectedPage.bleed" @change="store.updatePage(selectedPage.pageNo, { bleed: Number(($event.target as HTMLInputElement).value) })" /></label>
            <div class="binding-note"><i class="pi pi-info-circle" /><span>{{ selectedPage?.content }}</span></div>
          </div>
          <div v-else class="empty">在画布中选择一个版位以编辑属性。</div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>纸张规格</h3><Tag value="改动即失效" severity="warn" /></div>
          <div class="paper-form">
            <div class="pair"><label>纸宽 mm<input type="number" :value="store.paper.width" @change="store.updatePaper({ width: Number(($event.target as HTMLInputElement).value) })" /></label><label>纸高 mm<input type="number" :value="store.paper.height" @change="store.updatePaper({ height: Number(($event.target as HTMLInputElement).value) })" /></label></div>
            <div class="triple"><label>出血<input type="number" :value="store.paper.bleed" @change="store.updatePaper({ bleed: Number(($event.target as HTMLInputElement).value) })" /></label><label>安全区<input type="number" :value="store.paper.safe" @change="store.updatePaper({ safe: Number(($event.target as HTMLInputElement).value) })" /></label><label>槽距<input type="number" :value="store.paper.gutter" @change="store.updatePaper({ gutter: Number(($event.target as HTMLInputElement).value) })" /></label></div>
            <label>装订方式<select :value="store.paper.binding" @change="store.updatePaper({ binding: ($event.target as HTMLSelectElement).value })"><option v-for="b in bindingOptions" :key="b" :value="b">{{ b }}</option></select></label>
            <label>纸纹方向<select :value="store.paper.grain" @change="store.updatePaper({ grain: ($event.target as HTMLSelectElement).value })"><option v-for="g in grainOptions" :key="g" :value="g">{{ g }}</option></select></label>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>预检结果</h3><Tag :value="`${activeValidations.length} 项`" :severity="activeValidations.some((item) => item.severity === '错误') ? 'danger' : 'warn'" /></div>
          <div class="validation-list">
            <div v-for="issue in activeValidations" :key="issue.id" :class="['issue', issue.severity]">
              <button @click="locate(issue.pageNo)">
                <i :class="issue.severity === '错误' ? 'pi pi-times-circle' : 'pi pi-exclamation-triangle'" />
                <div><strong>{{ issue.title }}</strong><p>{{ issue.detail }}</p></div>
                <i class="pi pi-arrow-right" />
              </button>
              <Button v-if="issue.id.startsWith('bleed-')" size="small" label="补足到规格" severity="danger" text @click="fixBleed(issue.pageNo)" />
            </div>
          </div>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; }
.mb-3 { margin-bottom: 12px; }
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; padding: 12px; }
.paper-spec { margin-left: auto; color: #5d7077; font-size: 11px; }
.imposition-grid { display: grid; grid-template-columns: 220px minmax(0,1fr) 340px; gap: 12px; align-items: start; }
.pages-panel { max-height: 820px; overflow: auto; }
.page-list { padding: 8px; }
.page-list button { display: grid; width: 100%; grid-template-columns: 42px 1fr auto; gap: 8px; align-items: center; padding: 8px; border: 0; border-radius: 7px; text-align: left; background: transparent; cursor: pointer; }
.page-list button:hover:not(:disabled) { background: #eff5f4; }
.page-list button:disabled { opacity: .42; cursor: not-allowed; }
.thumb { display: grid; width: 38px; height: 50px; place-items: center; border: 1px solid #bdc7c9; background: #f4f3ef; font-size: 9px; font-weight: 800; }
.thumb i { width: 18px; height: 2px; background: #c36f42; }
.page-list strong, .page-list small { display: block; }
.page-list strong { font-size: 11px; }
.page-list small { margin-top: 4px; color: #7c898e; font-size: 9px; }
.canvas-panel { min-width: 0; }
.canvas-scroll { max-height: 820px; overflow: auto; padding: 18px; background: #34464c; }
.right-panel { display: grid; gap: 12px; }
.properties { display: grid; gap: 12px; padding: 14px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.properties label, .paper-form label { display: grid; gap: 5px; color: #5f7076; font-size: 11px; font-weight: 700; }
.properties input, .properties select, .paper-form input, .paper-form select { width: 100%; padding: 8px; border: 1px solid #cbd5d7; border-radius: 6px; font: inherit; }
.binding-note { display: flex; gap: 7px; padding: 9px; color: #6a604f; background: #fff5e7; font-size: 11px; line-height: 1.5; }
.empty { padding: 28px; color: #7e8a8f; text-align: center; font-size: 12px; }
.paper-form { display: grid; gap: 10px; padding: 14px; }
.triple { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
.validation-list { max-height: 320px; overflow: auto; padding: 7px; }
.issue { border-radius: 7px; }
.issue button { display: grid; width: 100%; grid-template-columns: 22px 1fr 16px; gap: 7px; padding: 10px; border: 0; border-radius: 7px; text-align: left; background: transparent; cursor: pointer; }
.issue button:hover { background: #f5f7f7; }
.issue.error > button > i:first-child { color: #bd4a34; }
.issue.warning > button > i:first-child { color: #bf7f2c; }
.issue strong { font-size: 11px; }
.issue p { margin: 4px 0 0; color: #738087; font-size: 10px; line-height: 1.45; }
.issue .p-button { margin: -4px 0 4px 30px; }
@media (max-width: 1200px) { .imposition-grid { grid-template-columns: 200px minmax(0,1fr); } .right-panel { grid-column: 1 / -1; grid-template-columns: 1fr 1fr; } }
@media (max-width: 760px) { .imposition-grid { grid-template-columns: 1fr; } .right-panel { grid-template-columns: 1fr; } .pages-panel { max-height: 300px; } }
</style>
