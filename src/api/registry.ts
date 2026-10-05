import type { ReleaseTask } from '../release/types'

// 模拟后端与前端之间的任务注册表：Pinia store 绑定后，
// Axios 适配器与生产总览读取的就是同一份放行状态。

export type TaskRegistry = {
  list: () => ReleaseTask[]
  resume: (id: string) => { task: ReleaseTask | undefined; blocked?: string }
}

let registry: TaskRegistry | null = null

export function bindExportRegistry(bound: TaskRegistry) {
  registry = bound
}

export function getExportRegistry(): TaskRegistry | null {
  return registry
}
