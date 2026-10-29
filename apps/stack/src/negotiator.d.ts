declare module "negotiator" {
  import type { IncomingMessage } from "node:http";
  export default class Negotiator {
    constructor(req: Pick<IncomingMessage, "headers">);
    /** Acceptable encodings from `available`, best first; `options.preferred` breaks ties before the client's own order. */
    encodings(available?: string[], options?: { preferred?: string[] }): string[];
  }
}
