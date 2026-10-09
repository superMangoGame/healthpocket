"use client";

import { CaretDown, Check, Plus, UserPlus, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/api";
import type { Profile, ProfileRelation } from "@/lib/types";
import { useProfiles } from "@/components/ProfileProvider";

const relationLabels: Record<ProfileRelation, string> = {
  self: "本人",
  spouse: "配偶",
  parent: "父母",
  child: "子女",
  other: "其他家人",
};

export function ProfileSwitcher({ compact = false }: { compact?: boolean }) {
  const { profiles, activeProfile, loading, error: profileError, selectProfile, refreshProfiles } = useProfiles();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [relation, setRelation] = useState<Exclude<ProfileRelation, "self">>("parent");
  const [birthDate, setBirthDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const addProfile = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const created = await apiFetch<Profile>("/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, relation, birth_date: birthDate || null }),
      });
      await refreshProfiles(created.id);
      setName("");
      setBirthDate("");
      setRelation("parent");
      dialog.current?.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法添加健康档案");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div ref={wrap} className={`profile-switcher ${compact ? "compact" : ""}`}>
        <button
          className="profile-switcher-button"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={loading || !activeProfile}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="profile-avatar" aria-hidden="true">{activeProfile?.name.slice(0, 1) || "·"}</span>
          <span className="profile-switcher-copy">
            <strong>{activeProfile?.name || (loading ? "加载中" : "健康档案")}</strong>
            <small>{activeProfile ? `${relationLabels[activeProfile.relation]} · ${activeProfile.report_count} 份报告` : profileError}</small>
          </span>
          <CaretDown size={14} />
        </button>
        {open && (
          <div className="profile-menu" role="menu" aria-label="切换健康档案">
            <div className="profile-menu-label">当前查看</div>
            {profiles.map((profile) => (
              <button key={profile.id} role="menuitemradio" aria-checked={profile.id === activeProfile?.id} onClick={() => { selectProfile(profile.id); setOpen(false); }}>
                <span className="profile-avatar small" aria-hidden="true">{profile.name.slice(0, 1)}</span>
                <span><strong>{profile.name}</strong><small>{relationLabels[profile.relation]} · {profile.report_count} 份报告</small></span>
                {profile.id === activeProfile?.id && <Check className="profile-check" weight="bold" />}
              </button>
            ))}
            <button className="profile-add" role="menuitem" onClick={() => { setOpen(false); dialog.current?.showModal(); }}>
              <span className="profile-avatar small"><Plus /></span>
              <span><strong>添加健康档案</strong><small>为家人导入体检报告</small></span>
            </button>
          </div>
        )}
      </div>
      <dialog ref={dialog} onClose={() => !busy && setError("")}>
        <form onSubmit={(event) => void addProfile(event)}>
          <div className="dialog-head">
            <div><h2>添加健康档案</h2><p>为家人建立独立的体检记录</p></div>
            <button type="button" className="button button-icon" aria-label="关闭" disabled={busy} onClick={() => dialog.current?.close()}><X /></button>
          </div>
          <div className="dialog-body profile-form">
            <div className="profile-form-intro"><UserPlus size={22} /><span>新增档案后会自动切换到该身份，后续导入的报告只会出现在他的档案中。</span></div>
            <label><span>姓名或称呼</span><input autoFocus required maxLength={40} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：妈妈" /></label>
            <label><span>与我的关系</span><select value={relation} onChange={(event) => setRelation(event.target.value as Exclude<ProfileRelation, "self">)}><option value="parent">父母</option><option value="spouse">配偶</option><option value="child">子女</option><option value="other">其他家人</option></select></label>
            <label><span>出生日期 <small>选填</small></span><input type="date" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} /></label>
            {error && <div className="error">{error}</div>}
            <div className="dialog-actions"><button type="button" className="button" disabled={busy} onClick={() => dialog.current?.close()}>取消</button><button className="button button-primary" disabled={busy || !name.trim()}>{busy ? "正在创建…" : "创建并切换"}</button></div>
          </div>
        </form>
      </dialog>
    </>
  );
}
