import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Role } from '../release/basis'

/** 各岗位对应的签核人。 */
export const roleMembers: Record<Role, string> = {
  拼版员: '林青',
  色彩管理: '周默',
  生产主管: '顾珩',
}

export const useSessionStore = defineStore('session', () => {
  const saved = localStorage.getItem('print-session-v1')
  const restored = saved ? JSON.parse(saved) : null
  const role = ref<Role>(restored?.role ?? '拼版员')
  const name = ref<string>(restored?.name ?? roleMembers['拼版员'])

  function setRole(next: Role) {
    role.value = next
    name.value = roleMembers[next]
    localStorage.setItem('print-session-v1', JSON.stringify({ role: role.value, name: name.value }))
  }

  const roleOptions = computed(() =>
    (Object.keys(roleMembers) as Role[]).map((r) => ({ label: `${r} · ${roleMembers[r]}`, value: r })),
  )

  return { role, name, roleOptions, setRole }
})
