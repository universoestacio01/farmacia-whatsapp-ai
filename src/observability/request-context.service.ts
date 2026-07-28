import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

interface RequestContextStore {
  traceId: string;
  conversationId?: string;
  whatsappMessageId?: string;
}

export class RequestContext {
  private static readonly storage = new AsyncLocalStorage<RequestContextStore>();

  static run<T>(context: Partial<RequestContextStore>, callback: () => T): T {
    return this.storage.run(
      {
        traceId: context.traceId || randomUUID(),
        conversationId: context.conversationId,
        whatsappMessageId: context.whatsappMessageId,
      },
      callback,
    );
  }

  static get() {
    return this.storage.getStore() || null;
  }

  static traceId() {
    return this.storage.getStore()?.traceId || null;
  }
}
