import { once } from "node:events";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

/**
 * Retire native resources on SDK closure and cancel pending stdout drains on shutdown.
 * Framing and input limits remain owned by the SDK.
 */
export class SessionTransport extends StdioServerTransport {
  declare private readonly cleanup: () => void;
  declare private readonly stdout: import("node:stream").Writable;

  private readonly lifetime = new AbortController();

  /**
   * Construct the transport with its native resource cleanup callback.
   */
  constructor(
    cleanup: () => void,
    stdin: import("node:stream").Readable = process.stdin,
    stdout: import("node:stream").Writable = process.stdout,
    options: ConstructorParameters<typeof StdioServerTransport>[2] = {}
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
   */
  async send(
    message: import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage
  ) {
    this.lifetime.signal.throwIfAborted();
    if (!this.stdout.write(serializeMessage(message))) {
      await once(this.stdout, "drain", { signal: this.lifetime.signal });
    }
  }
}
