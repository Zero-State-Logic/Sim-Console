/* Types for electron/server.cjs (used by the Vitest suite). */

import type { IncomingMessage, Server, ServerResponse } from 'node:http'

export interface StaticServer {
  server: Server
  port: number
  url: string
  close: () => Promise<void>
}

export declare const HOST: string
export declare const PREFERRED_PORT: number

export declare function createStaticHandler(root: string): (req: IncomingMessage, res: ServerResponse) => void
export declare function startStaticServer(options: { root: string; port?: number; host?: string }): Promise<StaticServer>
