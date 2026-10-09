const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export function apiUrl(path: string): string {
  const url = `${API_URL}${path}`;
  if (!API_URL.startsWith('/') || typeof window === 'undefined') return url;
  const tokenFromHash = new URLSearchParams(window.location.hash.slice(1)).get('healthpocket-token');
  if (tokenFromHash && /^[a-f0-9]{64}$/.test(tokenFromHash)) {
    window.sessionStorage.setItem('healthpocket-session-token', tokenFromHash);
  }
  const token = window.sessionStorage.getItem('healthpocket-session-token');
  return token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url;
}

export function withProfile(path: string, profileId: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}profile_id=${encodeURIComponent(profileId)}`;
}

/**
 * A failed API call, kept whole.
 *
 * Callers used to get a bare `Error` with the server's `detail`, so a request
 * that never left the machine and one Garmin rejected looked identical. The
 * status and the stage travel with the error so the UI can say which request
 * failed, how, and at which hop.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly stage: string | null = null,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && (reason.name === "TimeoutError" || reason.name === "AbortError" || /abort|timeout/i.test(reason.message));
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { cache: "no-store", ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    const raw = body as { detail?: unknown; stage?: unknown; hint?: unknown };
    const detail = typeof raw.detail === "string" ? raw.detail : (raw.detail as { message?: string } | undefined)?.message || "请求失败";
    throw new ApiError(detail, response.status,
      typeof raw.stage === "string" ? raw.stage : null,
      typeof raw.hint === "string" ? raw.hint : null);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
