import { ref, onMounted } from 'vue'
import { get } from '@/api'

const admin = ref<string | null>(null)

export function useAuth() {
  onMounted(async () => {
    if (admin.value) return
    const data = await get<{ admin: string }>('/api/me')
    admin.value = data.admin
  })

  return { admin }
}
