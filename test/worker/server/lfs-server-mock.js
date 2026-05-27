import { WorkerEntrypoint } from 'cloudflare:workers'

export class AdminEntrypoint extends WorkerEntrypoint {
}

export default { fetch: () => new Response('lfs-server-mock') }
