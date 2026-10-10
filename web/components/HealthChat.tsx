"use client";

import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { Brain, FileText, Gear, MagnifyingGlass, Paperclip, PaperPlaneRight, Sparkle, Stop, Watch, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import remarkGfm from "remark-gfm";
import { apiFetch } from "@/lib/api";
import type { AiSettings } from "@/lib/types";

type ChatVariant = "reports" | "daily";

const COPY: Record<ChatVariant, { title: string; placeholder: (name: string) => string; suggestions: string[]; disabled: string }> = {
  reports: {
    title: "问问你的健康数据",
    placeholder: (name) => `询问关于 ${name} 的体检报告和日常健康数据…`,
    suggestions: ["近几年最值得关注的变化是什么？", "哪些异常持续出现？", "帮我准备下次就诊要问的问题"],
    disabled: "完成模型配置后，可在这里输入问题和数据文件。",
  },
  daily: {
    title: "问问你的日常健康数据",
    placeholder: (name) => `询问 ${name} 的睡眠、HRV、运动等 Garmin 数据…`,
    suggestions: ["这段时间我的睡眠和 HRV 有什么变化？", "最近一个月运动量和上个月比怎么样？", "静息心率和压力有没有异常波动？"],
    disabled: "完成模型配置后，可在这里询问 Garmin 同步的睡眠、HRV 和运动数据。",
  },
};

const TOOL_LABELS: Record<string, string> = { garmin_daily_metrics: "查询 Garmin 每日指标", garmin_activities: "查询 Garmin 运动记录" };

/** A one-line trace of each Garmin lookup, so the answer shows which data it read. */
function ToolCall({ toolName, args, result }: { toolName: string; args: unknown; result?: unknown }) {
  const input = (args ?? {}) as { from?: string; to?: string };
  const output = (result ?? null) as { granularity?: string; points?: unknown[]; summary?: { count?: number } } | null;
  const size = output?.points ? `${output.points.length} 条${output.granularity === "week" ? "周均值" : output.granularity === "month" ? "月均值" : "记录"}` : output?.summary ? `${output.summary.count ?? 0} 次运动` : "查询中…";
  return <div className="chat-tool-call"><MagnifyingGlass />{TOOL_LABELS[toolName] ?? toolName}{input.from ? ` · ${input.from} 至 ${input.to}` : ""}<span>{size}</span></div>;
}

function ReasoningPart() {
  return <details className="chat-reasoning"><summary><Sparkle /> 模型思考过程</summary><MessagePartPrimitive.Text component="div" smooth={false} /></details>;
}

function MarkdownTable({ children, ...props }: ComponentPropsWithoutRef<"table">) {
  return <div className="aui-markdown-table-wrap"><table {...props}>{children}</table></div>;
}

function AssistantMessage() {
  return <MessagePrimitive.Root className="aui-message aui-assistant-message">
    <MessagePrimitive.Parts components={{ Text: () => <MarkdownTextPrimitive className="aui-markdown" remarkPlugins={[remarkGfm]} components={{ table: MarkdownTable }} />, Reasoning: ReasoningPart, tools: { Fallback: ToolCall } }} />
    <MessagePrimitive.Error><div className="health-chat-error">回答生成失败，请检查模型配置后重试。</div></MessagePrimitive.Error>
  </MessagePrimitive.Root>;
}

function UserMessage() {
  return <MessagePrimitive.Root className="aui-message aui-user-message">
    <div className="chat-message-files"><MessagePrimitive.Attachments>{({ attachment }) => <span className="chat-file-chip"><FileText />{attachment.name}</span>}</MessagePrimitive.Attachments></div>
    <MessagePrimitive.Parts components={{ Text: () => <MessagePartPrimitive.Text component="div" smooth={false} /> }} />
  </MessagePrimitive.Root>;
}

function ComposerAttachment() {
  return <AttachmentPrimitive.Root className="chat-file-chip"><FileText /><AttachmentPrimitive.Name /><AttachmentPrimitive.Remove aria-label="移除附件"><X /></AttachmentPrimitive.Remove></AttachmentPrimitive.Root>;
}

function HealthChatRuntime({ profileName, reportCount, settings, variant, beforeComposer }: { profileName: string; reportCount: number; settings: AiSettings; variant: ChatVariant; beforeComposer?: ReactNode }) {
  const copy = COPY[variant];
  const placeholder = variant === "daily" || reportCount ? copy.placeholder(profileName) : "输入数据或附加 CSV、JSON、Markdown、TXT 文件…";
  const suggestions = copy.suggestions;

  return <section className="health-chat panel has-assistant-ui">
      <div className="health-chat-heading"><span className="health-chat-icon">{variant === "daily" ? <Watch weight="duotone" /> : <Brain weight="duotone" />}</span><div><span className="eyebrow">AI 健康助手</span><h2>{copy.title}</h2></div><span className="health-chat-model">{settings.name} · {settings.model}</span></div>
      <ThreadPrimitive.Root className="aui-thread">
        <ThreadPrimitive.Viewport className="aui-thread-viewport">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <ThreadPrimitive.Empty><div className="chat-suggestions">{suggestions.map((item) => <ThreadPrimitive.Suggestion key={item} prompt={item} send>{item}</ThreadPrimitive.Suggestion>)}</div></ThreadPrimitive.Empty>
          <ThreadPrimitive.If running><div className="chat-thinking"><Sparkle /> 正在核对数据并生成回答…</div></ThreadPrimitive.If>
        </ThreadPrimitive.Viewport>
        {beforeComposer}
        <ComposerPrimitive.Root className="health-chat-composer">
          <div className="chat-composer-files"><ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} /></div>
          <ComposerPrimitive.Input rows={2} placeholder={placeholder} aria-label={copy.title} />
          <div className="chat-composer-actions"><ComposerPrimitive.AddAttachment multiple aria-label="附加数据文件"><Paperclip /></ComposerPrimitive.AddAttachment><ThreadPrimitive.If running><ComposerPrimitive.Cancel aria-label="停止生成"><Stop weight="fill" /></ComposerPrimitive.Cancel></ThreadPrimitive.If><ThreadPrimitive.If running={false}><ComposerPrimitive.Send aria-label="发送问题"><PaperPlaneRight weight="fill" /></ComposerPrimitive.Send></ThreadPrimitive.If></div>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
      <p className="health-chat-footnote">{variant === "daily" ? "AI 会按需查询已同步的 Garmin 数据，手表数据为估算值。" : "支持输入和附加 CSV、JSON、Markdown、TXT 数据。"}回答仅用于整理健康记录，不能替代医生诊断或治疗建议。</p>
    </section>;
}

/** `beforeComposer` renders between the conversation and the input box. */
export function HealthChat({ profileId, profileName, reportCount = 0, variant = "reports", beforeComposer }: { profileId: string | null; profileName: string; reportCount?: number; variant?: ChatVariant; beforeComposer?: ReactNode }) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { apiFetch<AiSettings>("/ai/settings").then(setSettings).catch((reason) => setError(reason.message)); }, [profileId]);
  if (error) return <section className="health-chat panel"><div className="health-chat-error">{error}</div></section>;
  if (!settings) return <section className="health-chat panel"><div className="chat-thinking"><Sparkle /> 正在读取模型配置…</div></section>;
  if (!settings.enabled || !profileId) return <section className="health-chat panel"><div className="health-chat-heading"><span className="health-chat-icon"><Brain weight="duotone" /></span><div><span className="eyebrow">AI 健康助手</span><h2>{COPY[variant].title}</h2></div><Link className="button" href="/settings"><Gear /> 配置模型</Link></div><div className="health-chat-disabled">{COPY[variant].disabled}</div></section>;
  return <HealthChatRuntime profileName={profileName} reportCount={reportCount} settings={settings} variant={variant} beforeComposer={beforeComposer} />;
}
