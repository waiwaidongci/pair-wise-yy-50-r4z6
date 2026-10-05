import axios, { type AxiosAdapter } from 'axios'
import { bindExportRegistry, getExportRegistry } from './registry'

// 模拟 REST 后端：任务数据与放行状态由 Pinia release store 注入，
// 保证总览、导出页与“后端”读到的是同一份放行状态。

export { bindExportRegistry }

const adapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => setTimeout(resolve, 160))
  const registry = getExportRegistry()
  if (!registry) return { data: null, status: 503, statusText: 'No Registry', headers: {}, config }

  if (config.url === '/api/print/export-tasks' && config.method === 'get') {
    return { data: structuredClone(registry.list()), status: 200, statusText: 'OK', headers: {}, config }
  }
  if (config.url?.match(/^\/api\/print\/export-tasks\/[^/]+\/resume$/) && config.method === 'post') {
    const id = config.url.split('/').at(-2) as string
    const result = registry.resume(id)
    if (result.blocked) {
      return { data: { message: result.blocked }, status: 409, statusText: 'Conflict', headers: {}, config }
    }
    return { data: structuredClone(result.task), status: 200, statusText: 'OK', headers: {}, config }
  }
  return { data: null, status: 404, statusText: 'Not Found', headers: {}, config }
}

const client = axios.create({ adapter })

export const exportApi = {
  list: () => client.get('/api/print/export-tasks'),
  resume: (id: string) => client.post(`/api/print/export-tasks/${id}/resume`),
}
