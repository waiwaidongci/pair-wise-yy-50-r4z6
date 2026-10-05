<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import ReleaseStatusPanel from '../components/ReleaseStatusPanel.vue'
import { useImpositionStore } from '../stores/imposition'
import { useReleaseStore } from '../stores/release'

const store = useImpositionStore()
const release = useReleaseStore()
const errors = computed(() => store.validations.filter((item) => item.severity === '错误').length)
const pendingProof = computed(() => store.proofs.find((proof) => proof.decision === '待决定'))
const invalidTasks = computed(() => store.tasks.filter((task) => task.status === '已失效').length)
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">PRINT PRODUCTION / 印刷生产</p><h1>拼版预检与放行总览</h1><p class="muted">发起放行批次后冻结版位、出血与色差依据，由拼版员、色彩管理、生产主管按岗位签核。</p></div>
      <div class="actions"><Button label="运行完整预检" icon="pi pi-check-circle" outlined /><Button label="进入拼版工作区" icon="pi pi-th-large" @click="$router.push('/imposition')" /></div>
    </div>

    <div class="metric-grid">
      <article class="metric"><span>页面文件</span><strong>{{ store.pages.length }}</strong><small>{{ store.positions.length }} 个已排版位</small></article>
      <article class="metric"><span>预检错误</span><strong class="error">{{ errors }}</strong><small>必须处理后方可签核</small></article>
      <article class="metric"><span>已签核环节</span><strong>{{ release.signedCount }}/3</strong><small>{{ release.pendingReviewCount }} 项待复核 · {{ release.invalidatedCount }} 项已失效</small></article>
      <article class="metric"><span>未完成导出</span><strong>{{ store.tasks.filter((task) => task.status !== '已完成').length }}</strong><small>{{ invalidTasks }} 项因依据变更失效</small></article>
    </div>

    <div class="overview-grid">
      <section class="panel">
        <div class="panel-head"><h3>当前拼版任务</h3><Tag :value="release.batch?.revision ?? store.revision" severity="info" /></div>
        <div class="project-card">
          <div>
            <strong>《潮汐来信》上海巡演节目册</strong>
            <p>成品 210 × 297mm · 8P · {{ store.sheet.binding }} · {{ store.sheet.width }} × {{ store.sheet.height }}mm 对开纸</p>
            <div class="specs"><span>CMYK + 专色</span><span>{{ store.sheet.grain }}纸纹</span><span>PDF/X-4</span><span>色彩控制条已配置</span></div>
          </div>
          <Button label="打开拼版" icon="pi pi-arrow-right" @click="$router.push('/imposition')" />
        </div>
        <div class="checklist">
          <div><i class="pi pi-check-circle" /><span>页面尺寸与成品规格</span><Tag value="通过" severity="success" /></div>
          <div><i :class="errors ? 'pi pi-times-circle error' : 'pi pi-check-circle'" /><span>出血与版位安全区</span><Tag :value="errors ? `${errors} 项错误` : '通过'" :severity="errors ? 'danger' : 'success'" /></div>
          <div><i :class="release.pendingReviewCount ? 'pi pi-exclamation-triangle warn' : 'pi pi-check-circle'" /><span>打样色差依据</span><Tag :value="release.pendingReviewCount ? '待复核' : '已齐备'" :severity="release.pendingReviewCount ? 'warn' : 'success'" /></div>
          <div><i :class="release.isReleased ? 'pi pi-check-circle' : 'pi pi-lock'" /><span>放行状态</span><Tag :value="release.releaseStatus" :severity="release.isReleased ? 'success' : 'info'" /></div>
        </div>
      </section>

      <aside>
        <ReleaseStatusPanel />
        <section class="panel export-mini">
          <div class="panel-head"><h3>导出任务</h3><Tag :value="release.releaseStatus" :severity="release.isReleased ? 'success' : 'info'" /></div>
          <div v-for="task in store.tasks" :key="task.id">
            <div><span>{{ task.name }}</span><strong>{{ task.progress }}%</strong></div>
            <ProgressBar :value="task.progress" :showValue="false" :style="{ height: '7px' }" />
            <small>{{ task.status }} · {{ task.updatedAt }}</small>
          </div>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.metric .error { color: #b84e35; }
.overview-grid { display: grid; grid-template-columns: minmax(0,1fr) 380px; gap: 14px; align-items: start; }
.project-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px; }
.project-card strong { font-size: 17px; }
.project-card p { margin: 7px 0 14px; color: #66757c; }
.specs { display: flex; flex-wrap: wrap; gap: 7px; }
.specs span { padding: 5px 8px; border-radius: 5px; color: #45676d; background: #eef4f4; font-size: 10px; }
.checklist { padding: 0 18px 16px; }
.checklist > div { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 9px; padding: 11px 0; border-top: 1px solid #ecf0f0; font-size: 12px; }
.checklist i { color: #3b8a67; }
.checklist i.warn { color: #c4872f; }
.checklist i.error { color: #bb4c35; }
aside { display: grid; gap: 14px; }
.export-mini > div:not(.panel-head) { padding: 11px 16px 4px; }
.export-mini > div > div { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 11px; }
.export-mini small { display: block; margin-top: 5px; color: #7d898e; }
@media (max-width: 1050px) { .overview-grid { grid-template-columns: 1fr; } }
</style>
