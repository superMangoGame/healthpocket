import type {
  GenericThreadHistoryAdapter,
  MessageFormatAdapter,
  MessageFormatItem,
  MessageStorageEntry,
  ThreadHistoryAdapter,
} from "@assistant-ui/react";

type StoredHistory<TStorageFormat extends Record<string, unknown>> = {
  headId?: string | null;
  messages: MessageStorageEntry<TStorageFormat>[];
};

type ChatStorage = Pick<Storage, "getItem" | "setItem">;

export function createSessionHistoryAdapter(profileId: string | null, suppliedStorage?: ChatStorage): ThreadHistoryAdapter {
  const storageKey = `healthpocket-ai-chat:${profileId ?? "unselected"}`;
  const getStorage = (): ChatStorage | null => suppliedStorage ?? (typeof window === "undefined" ? null : window.sessionStorage);

  return {
    async load() { return { messages: [] }; },
    async append() {},
    withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
      format: MessageFormatAdapter<TMessage, TStorageFormat>,
    ): GenericThreadHistoryAdapter<TMessage> {
      const read = (): StoredHistory<TStorageFormat> => {
        const storage = getStorage();
        if (!storage) return { messages: [] };
        try {
          const parsed = JSON.parse(storage.getItem(storageKey) ?? "null") as Partial<StoredHistory<TStorageFormat>> | null;
          if (!parsed || !Array.isArray(parsed.messages)) return { messages: [] };
          const messages = parsed.messages.filter((item): item is MessageStorageEntry<TStorageFormat> => Boolean(
            item && typeof item === "object"
            && typeof item.id === "string"
            && (item.parent_id === null || typeof item.parent_id === "string")
            && item.format === format.format
            && item.content && typeof item.content === "object",
          ));
          const headId = parsed.headId === null || typeof parsed.headId === "string" ? parsed.headId : undefined;
          return { ...(headId !== undefined ? { headId } : {}), messages };
        } catch {
          return { messages: [] };
        }
      };
      const write = (history: StoredHistory<TStorageFormat>) => {
        getStorage()?.setItem(storageKey, JSON.stringify(history));
      };
      const store = (item: MessageFormatItem<TMessage>, previousId?: string) => {
        const history = read();
        const id = format.getId(item.message);
        const row: MessageStorageEntry<TStorageFormat> = {
          id,
          parent_id: item.parentId,
          format: format.format,
          content: format.encode(item),
        };
        const index = history.messages.findIndex((message) => message.id === (previousId ?? id));
        if (index >= 0) history.messages[index] = row;
        else history.messages.push(row);
        history.headId = id;
        write(history);
      };

      return {
        async load() {
          const history = read();
          return {
            ...(history.headId !== undefined ? { headId: history.headId } : {}),
            messages: history.messages.map((message) => format.decode(message)),
          };
        },
        async append(item) { store(item); },
        async update(item, localMessageId) { store(item, localMessageId); },
        async delete(items) {
          const ids = new Set(items.map((item) => format.getId(item.message)));
          const history = read();
          history.messages = history.messages.filter((message) => !ids.has(message.id));
          if (history.headId && ids.has(history.headId)) history.headId = history.messages.at(-1)?.id ?? null;
          write(history);
        },
      };
    },
  };
}
