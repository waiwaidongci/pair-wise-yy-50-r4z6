<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import { ROLE_LABEL, type BatchStatus } from './release/types'
import { useReleaseStore } from './stores/release'
import { useImpositionStore } from './stores/imposition'

const route = useRoute()
const release = useReleaseStore()
const imposition = useImpositionStore()
const mobileOpen = ref(false)
const title = computed(() => String(route.meta.title ?? '拼版工作台'))
const nav = [
  { to: '/', label: '生产总览', icon: 'pi pi-chart-pie' },
  { to: '/imposition', label: '拼版工作区', icon: 'pi pi-th-large' },
  { to: '/proofs', label: '打样审批', icon: 'pi pi-image' },
  { to: '/versions', label: '版本对比', icon: 'pi pi-copy' },
  { to: '/exports', label: '导出任务', icon: 'pi pi-download' },
]

const statusMeta: Record<BatchStatus, { label: string; severity: 'success' | 'warn' | 'danger' | 'info' }> = {
  待复核: { label: '待复核', severity: 'warn' },
  待签核: { label: '待签核', severity: 'info' },
  依据已变更: { label: '依据已变更', severity: 'danger' },
  已放行: { label: '已放行', severity: 'success' },
  已归档: { label: '已归档', severity: 'success' },
}
const batch = computed(() => release.state.activeBatch)
const meta = computed(() => (batch.value ? statusMeta[batch.value.status] : null))
const doneCount = computed(() => batch.value?.signoffs.filter((s) => s.status === '已签核').length ?? 0)
</script>

<template>
  <div class="shell">
    <header class="mobile-bar">
      <Button icon="pi pi-bars" text severity="contrast" @click="mobileOpen = !mobileOpen" />
      <strong>{{ title }}</strong>
      <Tag v-if="meta" :value="meta.label" :severity="meta.severity" />
    </header>
    <aside :class="{ open: mobileOpen }">
      <div class="brand">
        <div class="brand-mark">放行</div>
        <div><strong>印刷生产中心</strong><small>《潮汐来信》节目册 · 放行批次</small></div>
      </div>

      <div class="operator-card">
        <div class="operator-line">
          <span class="terminal" :class="release.operator.terminal">终端 {{ release.operator.terminal }}</span>
          <strong>{{ release.operator.name }}</strong>
          <em>{{ ROLE_LABEL[release.operator.role] }}</em>
        </div>
        <label class="operator-switch">
          切换岗位/终端
          <select :value="release.state.operatorId" @change="release.switchOperator(($event.target as HTMLSelectElement).value)">
            <option v-for="op in release.operators" :key="op.id" :value="op.id">{{ op.name }} · {{ ROLE_LABEL[op.role] }} · 终端 {{ op.terminal }}</option>
          </select>
        </label>
      </div>

      <nav>
        <RouterLink v-for="item in nav" :key="item.to" :to="item.to" @click="mobileOpen = false">
          <i :class="item.icon" />{{ item.label }}
        </RouterLink>
      </nav>

      <div class="sidebar-status">
        <template v-if="batch">
          <div class="batch-line">
            <Tag :value="meta?.label ?? batch.status" :severity="meta?.severity ?? 'info'" />
            <span class="version">{{ batch.revision }} · v{{ batch.version }}</span>
          </div>
          <div class="sign-dots">
            <i v-for="s in batch.signoffs" :key="s.slot" :class="s.status" :title="`${s.slot} · ${s.status}${s.signedBy ? ' · ' + s.signedBy : ''}`" />
          </div>
          <small>签核 {{ doneCount }}/{{ batch.signoffs.length }} · 发起人 {{ batch.initiatedBy }}</small>
        </template>
        <template v-else>
          <div><span class="dot idle" />尚未发起放行批次</div>
          <small>版本 {{ imposition.revision }} · 编辑自动保存草稿</small>
        </template>
      </div>
    </aside>

    <main>
      <Transition name="toast">
        <div v-if="release.flash" class="flash" :class="release.flash.severity" @click="release.flash = null">
          <i :class="release.flash.severity === 'success' ? 'pi pi-check-circle' : release.flash.severity === 'error' ? 'pi pi-times-circle' : 'pi pi-exclamation-triangle'" />
          <span>{{ release.flash.text }}</span>
          <i class="pi pi-times close" />
        </div>
      </Transition>
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; background: #eff2f2; }
aside { position: fixed; inset: 0 auto 0 0; z-index: 20; display: flex; width: 248px; flex-direction: column; color: #e8f0f1; background: #283b42; }
.brand { display: flex; align-items: center; gap: 11px; padding: 20px 16px 14px; border-bottom: 1px solid rgba(255,255,255,.1); }
.brand-mark { display: grid; width: 42px; height: 42px; place-items: center; border: 1px solid #d49155; border-radius: 9px; color: #f3c394; font-size: 13px; font-weight: 800; }
.brand strong, .brand small { display: block; }
.brand strong { font-size: 14px; }
.brand small { margin-top: 4px; color: #9dafb4; font-size: 10px; }
.operator-card { margin: 12px; padding: 10px 12px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; background: rgba(255,255,255,.05); }
.operator-line { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.operator-line em { margin-left: auto; color: #9db4ba; font-size: 10px; font-style: normal; }
.terminal { padding: 2px 7px; border-radius: 20px; font-size: 10px; font-weight: 800; font-style: normal; }
.terminal.A { color: #10303a; background: #7fd4cf; }
.terminal.B { color: #3a2310; background: #f0b878; }
.operator-switch { display: grid; gap: 5px; margin-top: 9px; color: #93a7ad; font-size: 10px; }
.operator-switch select { width: 100%; padding: 6px; border: 1px solid rgba(255,255,255,.18); border-radius: 6px; color: #e6eef0; background: #31464e; font-size: 11px; }
nav { display: grid; gap: 5px; padding: 6px 10px; }
nav a { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-radius: 7px; color: #becdd1; text-decoration: none; font-size: 13px; }
nav a.router-link-active { color: white; background: #3a555d; box-shadow: inset 3px 0 #d59456; }
.sidebar-status { margin: auto 12px 14px; padding: 12px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; background: rgba(255,255,255,.04); }
.batch-line { display: flex; align-items: center; justify-content: space-between; }
.batch-line .version { color: #a9bcc1; font-family: monospace; font-size: 10px; }
.sign-dots { display: flex; gap: 7px; margin: 11px 0 8px; }
.sign-dots i { width: 100%; height: 7px; border-radius: 4px; background: #465b62; }
.sign-dots i.已签核 { background: #58b38a; }
.sign-dots i.已作废 { background: #c45a45; }
.sidebar-status div { font-size: 11px; font-weight: 700; }
.sidebar-status .dot { display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; background: #58b38a; }
.sidebar-status .dot.idle { background: #d9a04d; }
.sidebar-status small { display: block; margin-top: 6px; color: #96a9ae; font-size: 9px; }
main { min-width: 0; margin-left: 248px; padding-top: 8px; }
.flash { position: fixed; top: 14px; right: 16px; z-index: 60; display: flex; align-items: center; gap: 10px; max-width: 520px; padding: 12px 14px; border-radius: 9px; color: #23353b; background: white; box-shadow: 0 14px 40px rgba(20,40,48,.22); font-size: 12px; cursor: pointer; }
.flash i:first-child { font-size: 16px; }
.flash.success { border-left: 4px solid #3b8a67; }
.flash.success i:first-child { color: #3b8a67; }
.flash.error { border-left: 4px solid #bd4a34; }
.flash.error i:first-child { color: #bd4a34; }
.flash.warn { border-left: 4px solid #c4872f; }
.flash.warn i:first-child { color: #c4872f; }
.flash .close { color: #93a2a8; font-size: 11px; }
.toast-enter-active, .toast-leave-active { transition: all .22s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(-10px); }
.mobile-bar { display: none; }
@media (max-width: 820px) {
  aside { left: -270px; transition: left .18s ease; }
  aside.open { left: 0; }
  main { margin-left: 0; }
  .mobile-bar { position: sticky; top: 0; z-index: 15; display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 7px 10px; color: white; background: #283b42; }
  .mobile-bar strong { flex: 1; }
}
</style>
