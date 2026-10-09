"use client";

import {
  AssistantRuntimeProvider,
  SimpleTextAttachmentAdapter,
  type AttachmentAdapter,
} from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
import { createContext, useContext, useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import { apiUrl } from "@/lib/api";
import { createSessionHistoryAdapter } from "@/lib/chat-history";
import { useProfiles } from "@/components/ProfileProvider";

function createDataAttachmentAdapter(): AttachmentAdapter {
  const textAdapter = new SimpleTextAttachmentAdapter();
  return {
    accept: ".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json",
    async add({ file }) {
      if (file.size > 200 * 1024) throw new Error("单个数据文件不能超过 200 KB");
      return textAdapter.add({ file });
    },
    remove: () => textAdapter.remove(),
    send: (attachment) => textAdapter.send(attachment),
  };
}

/** What the page the chat is opened from is looking at, sent with every question. */
export interface HealthChatScope {
  /** The date range the daily-health page shows; the AI reads "最近" / "这段时间" against it. */
  garmin_range?: { from: string; to: string } | null;
}

const ScopeContext = createContext<MutableRefObject<HealthChatScope> | null>(null);

/** Publishes the calling page's scope to the chat for as long as the page is mounted. */
export function useHealthChatScope(scope: HealthChatScope) {
  const ref = useContext(ScopeContext);
  const key = JSON.stringify(scope);
  useEffect(() => {
    if (!ref) return;
    ref.current = JSON.parse(key) as HealthChatScope;
    return () => { ref.current = {}; };
  }, [ref, key]);
}

function ProfileChatRuntime({ profileId, scope, children }: { profileId: string | null; scope: MutableRefObject<HealthChatScope>; children: ReactNode }) {
  const attachments = useMemo(() => createDataAttachmentAdapter(), []);
  const history = useMemo(() => createSessionHistoryAdapter(profileId), [profileId]);
  const transport = useMemo(() => new AssistantChatTransport({
    api: apiUrl("/ai/chat"),
    // Resolved per request, so the scope is the one on screen when the question is sent.
    body: () => ({ profile_id: profileId ?? "", ...scope.current }),
  }), [profileId, scope]);
  const runtime = useChatRuntime({
    id: `healthpocket-${profileId ?? "unselected"}`,
    transport,
    adapters: { attachments, history },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

export function HealthChatProvider({ children }: { children: ReactNode }) {
  const { activeProfileId } = useProfiles();
  const scope = useRef<HealthChatScope>({});
  return <ScopeContext.Provider value={scope}><ProfileChatRuntime key={activeProfileId ?? "unselected"} profileId={activeProfileId} scope={scope}>{children}</ProfileChatRuntime></ScopeContext.Provider>;
}
