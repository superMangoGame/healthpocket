"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import type { Profile } from "@/lib/types";

const STORAGE_KEY = "healthpocket-active-profile";

interface ProfileContextValue {
  profiles: Profile[];
  activeProfile: Profile | null;
  activeProfileId: string | null;
  loading: boolean;
  error: string;
  selectProfile: (profileId: string) => void;
  refreshProfiles: (preferredProfileId?: string) => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refreshProfiles = useCallback(async (preferredProfileId?: string) => {
    try {
      const nextProfiles = await apiFetch<Profile[]>("/profiles");
      setProfiles(nextProfiles);
      setActiveProfileId((current) => {
        const stored = preferredProfileId || current || window.localStorage.getItem(STORAGE_KEY);
        const next = nextProfiles.find((profile) => profile.id === stored)
          || nextProfiles.find((profile) => profile.is_default)
          || nextProfiles[0]
          || null;
        if (next) window.localStorage.setItem(STORAGE_KEY, next.id);
        return next?.id || null;
      });
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法加载健康档案");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refreshProfiles(); }, [refreshProfiles]);

  const selectProfile = useCallback((profileId: string) => {
    setActiveProfileId(profileId);
    window.localStorage.setItem(STORAGE_KEY, profileId);
  }, []);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) || null;
  const value = useMemo(() => ({
    profiles,
    activeProfile,
    activeProfileId,
    loading,
    error,
    selectProfile,
    refreshProfiles,
  }), [profiles, activeProfile, activeProfileId, loading, error, selectProfile, refreshProfiles]);

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfiles(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) throw new Error("useProfiles 必须在 ProfileProvider 内使用");
  return value;
}
