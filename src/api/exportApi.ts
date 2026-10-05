import axios, { type AxiosAdapter } from 'axios'
import { useImpositionStore } from '../stores/imposition'

/**
 * 导出任务 REST 层（模拟）。
 * 任务以拼版 store 为唯一数据源：批次发起时关联批次、依据变更后未完成任务
 * 置为「已失效」，导出队列与总览因此显示同一套放行状态。
 */
const adapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => setTimeout(resolve, 160))
  const store = useImpositionStore()

  if (config.url === '/api/print/export-tasks' && config.method === 'get') {
    return { data: structuredClone(store.tasks), status: 200, statusText: 'OK', headers: {}, config }
  }
  if (config.url?.match(/^\/api\/print\/export-tasks\/[^/]+\/resume$/) && config.method === 'post') {
    const id = config.url.split('/').at(-2)
    const task = store.tasks.find((item) => item.id === id)
    if (task && task.resumable && task.status !== '已失效') {
      task.status = '生成中'
      task.progress = Math.max(task.progress, 12)
      task.updatedAt = '刚刚'
    }
    return { data: structuredClone(task), status: 200, statusText: 'OK', headers: {}, config }
  }
  return { data: null, status: 404, statusText: 'Not Found', headers: {}, config }
}

const client = axios.create({ adapter })

export const exportApi = {
  list: () => client.get('/api/print/export-tasks'),
  resume: (id: string) => client.post(`/api/print/export-tasks/${id}/resume`),
}
