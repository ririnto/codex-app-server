import { once } from "node:events";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

/**
 * Retire native resources on SDK closure and cancel pending stdout drains on shutdown.
 * Framing and input limits remain owned by the SDK.
 */
export class SessionTransport extends StdioServerTransport {
  lifetime = new AbortController();

  /**
   * @param {() => void} cleanup - Retire owned resources.
   * @param {import("node:stream").Readable} stdin - MCP input.
   * @param {import("node:stream").Writable} stdout - MCP output.
   * @param {ConstructorParameters<typeof StdioServerTransport>[2]} options - Transport options.
   */
  constructor(
    cleanup,
    stdin = process.stdin,
    stdout = process.stdout,
    options = {}
  ) {
    super(stdin, stdout, options);
    this.cleanup = cleanup;
    this.stdout = stdout;
  }

  /**
   * Close the transport and retire resources.
   */
  async close() {
    this.lifetime.abort(new Error("MCP transport is closed"));
    this.cleanup();
    await super.close();
  }

  /**
   * Send a framed MCP message.
   * @param {import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage} message - MCP message.
   */
  async send(message) {
    this.lifetime.signal.throwIfAborted();
    if (!this.stdout.write(serializeMessage(message))) {
      await once(this.stdout, "drain", { signal: this.lifetime.signal });
    }
  }
}
