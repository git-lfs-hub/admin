declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../../worker/index.ts");
  }
}
