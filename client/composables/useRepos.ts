import { ref, onMounted } from 'vue'
import { get } from '@/api'
import type { RepoRow } from '@/types'

export function useRepos() {
  const repos = ref<RepoRow[]>([])
  const loading = ref(true)
  const error = ref<Error | null>(null)

  async function load() {
    loading.value = true
    error.value = null
    try {
      const data = await get<{ repos: RepoRow[] }>('/api/repos')
      repos.value = data.repos
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e))
    } finally {
      loading.value = false
    }
  }

  function reload() {
    load()
  }

  onMounted(load)

  return { repos, loading, error, reload }
}
