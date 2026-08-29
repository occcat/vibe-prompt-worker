import { DurableObject } from "cloudflare:workers";

export class VaultObject extends DurableObject<Env> {
  fetch(): Response {
    return new Response("Not Implemented", { status: 501 });
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not Implemented", { status: 501 });
  },
} satisfies ExportedHandler<Env>;
