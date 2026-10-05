<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import { useReleaseStore } from '../stores/release'
import { bindExportRegistry, exportApi } from '../api/exportApi'

const release = useReleaseStore()
const queryClient = useQueryClient()

// 把 store 注入“REST 后端”，保证网络层与总览是同一放行状态
bindExportRegistry({
  list: () => release.state.tasks,
  resume: (id) => {
    const task = release.state.tasks.find((t) => t.id === id)
    if (!task) return { task: undefined }
    if (task.status === '已失效') {
      release.resumeTask(id) // 放行后转重算；未放行给出提示
      return { task: release.state.tasks.find((t) => t.id === id) }
    }
    if (!release.canExport || (release.state.activeBatch && task.basisVersion !== release.state.activeBatch.version)) {
      return { task, blocked: '依据版本不匹配或批次未放行' }
    }
    release.resumeTask(id)
    return { task: release.state.tasks.find((t) => t.id === id) }
  },
})

const { data: tasks, refetch } = useQuery({
  queryKey: ['export-tasks'],
  queryFn: async () => (await exportApi.list()).data,
  initialData: release.state.tasks,
  refetchInterval: 2600,
})

watch(
  () => release.state.tasks,
  () => queryClient.setQueryData(['export-tasks'], structuredClone(release.state.tasks)),
  { deep: true },
)

const resumeMutation = useMutation({
  mutationFn: async (id: string) => (await exportApi.resume(id)).data,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
    refetch()
  },
})

function statusSeverity(status?: string) {
  return status === '已完成' ? 'success' : status === '已中断' ? 'danger' : status === '生成中' ? 'warn' : status === '已失效' ? 'danger' : 'info'
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">EXPORT JOBS / 导出任务</p><h1>放行批次驱动的导出队列</h1><p class="muted">队列与生产总览读同一份放行状态；依据一改，未完成任务立即失效，放行后按新依据重算。</p></div>
      <Button label="新建印刷交付包" icon="pi pi-plus" :disabled="!release.canExport" :severity="release.canExport ? 'primary' : 'secondary'" @click="release.enqueueExport('印刷交付包 · PDF/X-4')" />
    </div>

    <div class="gate" :class="release.state.activeBatch?.status ?? 'empty'">
      <i :class="release.canExport ? 'pi pi-unlock' : 'pi pi-lock'" />
      <div>
        <strong>{{ release.canExport ? '批次已放行，导出已解锁' : release.state.activeBatch ? `批次状态：${release.state.activeBatch.status}` : '尚未发起放行批次' }}</strong>
        <p v-if="release.state.activeBatch">{{ release.state.activeBatch.revision }} · 依据 v{{ release.state.activeBatch.version }} · 任务将锁定该版本哈希</p>
        <p v-else>三岗签核齐全前，新导出按钮锁定，中断任务不允许恢复。</p>
      </div>
      <Button label="去签核" icon="pi pi-check" size="small" outlined @click="$router.push('/')" />
    </div>

    <div class="export-grid">
      <section class="panel">
        <div class="panel-head"><h3>导出队列</h3><span class="muted">Axios 模拟 REST · 与总览同源</span></div>
        <div class="task-list">
          <article v-for="task in (tasks ?? release.state.tasks)" :key="task.id" :class="{ invalid: task.status === '已失效' }">
            <div class="task-head">
              <div><strong>{{ task.name }}</strong><small>{{ task.id }} · {{ task.updatedAt }}<em v-if="task.basisVersion != null"> · 批次 {{ task.batchId }} v{{ task.basisVersion }}</em></small></div>
              <Tag :value="task.status" :severity="statusSeverity(task.status)" />
            </div>
            <ProgressBar :value="task.progress" :showValue="false" :style="{ height: '8px' }" />
            <div class="task-foot">
              <span>{{ task.status === '已失效' ? (task.invalidReason ?? '依据已变更') : task.progress === 100 ? '文件哈希已校验' : `保留 ${task.progress}% 分片，断点可恢复` }}</span>
              <div class="buttons">
                <Button v-if="task.status === '已失效'" label="放行后重算" icon="pi pi-refresh" size="small" severity="danger" :disabled="!release.canExport" @click="release.recomputeTask(task.id); resumeMutation.mutate(task.id)" />
                <Button v-else-if="task.status === '已中断' || task.status === '排队中' || task.status === '生成中'" label="恢复任务" icon="pi pi-play" size="small" :disabled="!release.canExport" :loading="resumeMutation.isPending.value" @click="resumeMutation.mutate(task.id)" />
                <Button v-else label="打开结果" icon="pi pi-external-link" size="small" text />
              </div>
            </div>
          </article>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>交付包冻结内容</h3><Tag :value="release.state.activeBatch ? `v${release.state.activeBatch.version}` : '未冻结'" /></div>
          <div class="package-list">
            <div><i class="pi pi-th-large" /><span>版位快照</span><strong>{{ release.state.activeBatch?.basis.positionsHash ?? '—' }}</strong></div>
            <div><i class="pi pi-file-pdf" /><span>拼版 PDF/X-4</span><strong>{{ release.canExport ? '可生成' : '待放行' }}</strong></div>
            <div><i class="pi pi-image" /><span>打样决定</span><strong>{{ release.state.activeBatch ? `${release.state.activeBatch.basis.proof.decision} ΔE ${release.state.activeBatch.basis.proof.deltaE}` : '—' }}</strong></div>
            <div><i class="pi pi-database" /><span>纸张/折手规格</span><strong>{{ release.state.activeBatch ? `${release.state.activeBatch.basis.sheetWidth}×${release.state.activeBatch.basis.sheetHeight}` : '—' }}</strong></div>
            <div><i class="pi pi-history" /><span>恢复锚点</span><strong>{{ release.state.activeBatch?.lastFullSignoffAt ? '最后完整签核' : '无' }}</strong></div>
          </div>
        </section>
        <section class="panel recovery">
          <div class="panel-head"><h3>原子写盘与恢复</h3></div>
          <p>任务进度与签核同事务落盘（临时区 → 主区 → 备份）。写盘失败时回到最后一次完整签核锚点重试，半截 JSON 在启动时直接丢弃，绝不出现半批。</p>
          <div class="fault-buttons">
            <Button size="small" label="注入临时区失败" severity="warn" outlined @click="release.armFault('phase1')" />
            <Button size="small" label="注入提交中途失败" severity="danger" outlined @click="release.armFault('phase2')" />
          </div>
          <Button label="重置演示数据" severity="secondary" outlined fluid @click="release.resetDemo" />
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.gate { display: flex; align-items: center; gap: 13px; margin-bottom: 14px; padding: 13px 16px; border: 1px solid #dce3e4; border-radius: 10px; background: white; }
.gate > i { font-size: 24px; color: #93a2a8; }
.gate.已放行 { border-color: #92c7ab; background: #f1faf5; }
.gate.已放行 > i { color: #3b8a67; }
.gate.依据已变更, .gate.待复核 { border-color: #e0a194; background: #fdf1ee; }
.gate.依据已变更 > i, .gate.待复核 > i { color: #bd4a34; }
.gate div { flex: 1; }
.gate strong { font-size: 13px; }
.gate p { margin: 4px 0 0; color: #74828a; font-size: 11px; }
.export-grid { display: grid; grid-template-columns: minmax(0,1fr) 330px; gap: 14px; align-items: start; }
.task-list { padding: 8px 16px 16px; }
.task-list article { padding: 15px 0; border-bottom: 1px solid #e9eeee; }
.task-list article.invalid { opacity: .92; }
.task-head, .task-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.task-head { margin-bottom: 11px; }
.task-head strong, .task-head small { display: block; }
.task-head small { margin-top: 4px; color: #7c898f; font-size: 10px; }
.task-head em { font-style: normal; color: #5d7b80; }
.task-foot { margin-top: 9px; }
.task-foot span { color: #68777e; font-size: 10px; }
.buttons { display: flex; gap: 6px; }
aside { display: grid; gap: 14px; }
.package-list { padding: 8px 16px 16px; }
.package-list div { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 1px solid #edf1f1; font-size: 11px; }
.package-list i { color: #397d64; }
.package-list strong { color: #536b72; font-size: 10px; }
.recovery p { padding: 0 16px; color: #67767d; font-size: 11px; line-height: 1.6; }
.fault-buttons { display: flex; gap: 7px; padding: 0 16px 10px; flex-wrap: wrap; }
.recovery :deep(.p-button) { width: calc(100% - 32px); margin: 0 16px 16px; }
@media (max-width: 1000px) { .export-grid { grid-template-columns: 1fr; } }
</style>
