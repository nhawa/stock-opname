export type Role = "STAFF" | "MANAGER";
export type Status = "COUNTING" | "SUBMITTED" | "APPROVED" | "REJECTED";
export type User = { id: string; storeId: string; email: string; name: string; role: Role };
export type SessionItem = { id: string; productId: string; sku: string; name: string; unit: string; snapshotQty: string; snapshotVersion: string; countedQty: string | null; countCutoffVersion: string | null; countedAt: string | null; countedBy: string | null; draftVersion: string; reservationToken: string | null; reservedBy: string | null; reservationVersion: string | null; reservationExpiresAt: string | null };
export type Session = { id: string; storeId: string; status: Status; initiatedBy: string; initiatedAt: string; submittedBy: string | null; submittedAt: string | null; approvedBy: string | null; approvedAt: string | null; rejectedBy: string | null; rejectedAt: string | null; rejectionReason: string | null; items?: SessionItem[] };
export type Review = Omit<Session, "items"> & { items: (SessionItem & { expectedAtCount: string; variance: string })[] };
type ApiError = { error?: { message?: string; code?: string } };

const url = process.env.NEXT_PUBLIC_API_URL ?? "/api";
let token: string | null = typeof window === "undefined" ? null : sessionStorage.getItem("stock-opname-token");
export function setToken(value: string | null) { token = value; if (typeof window !== "undefined") { if (value) sessionStorage.setItem("stock-opname-token", value); else sessionStorage.removeItem("stock-opname-token"); } }
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${url}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
  if (!response.ok) { const body = await response.json().catch(() => ({})) as ApiError; throw new Error(body.error?.message ?? `Request failed (${response.status})`); }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const api = {
  login: (email: string, password: string) => request<{ accessToken: string; expiresIn: number }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => request<User>("/auth/me"),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  sessions: () => request<Session[]>("/stock-opname/sessions"),
  session: (id: string) => request<Session>(`/stock-opname/sessions/${id}`),
  initiate: () => request<Session>("/stock-opname/sessions", { method: "POST", body: "{}" }),
  reserve: (sessionId: string, productId: string) => request<SessionItem>(`/stock-opname/sessions/${sessionId}/counts/reservations`, { method: "POST", body: JSON.stringify({ productId }) }),
  saveDraft: (sessionId: string, counts: { productId: string; reservationToken: string; draftVersion: string; countedQty: string }[]) => request<SessionItem[]>(`/stock-opname/sessions/${sessionId}/counts/draft`, { method: "POST", body: JSON.stringify({ counts }) }),
  submit: (id: string) => request<Session>(`/stock-opname/sessions/${id}/submit`, { method: "POST", body: "{}" }),
  review: (id: string) => request<Review>(`/stock-opname/sessions/${id}/review`),
  approve: (id: string) => request<Session>(`/stock-opname/sessions/${id}/approve`, { method: "POST", body: "{}" }),
  reject: (id: string, reason: string) => request<Session>(`/stock-opname/sessions/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) }),
};
