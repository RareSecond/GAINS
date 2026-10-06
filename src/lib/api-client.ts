export class ApiError extends Error { constructor(public code: string, message: string, public status: number) { super(message) } }
export async function apiGet<T>(action: string, params: Record<string, string> = {}): Promise<T> {
  return request<T>(`/api/data?${new URLSearchParams({ action, ...params })}`)
}
export async function apiPost<T>(body: unknown): Promise<T> { return request<T>('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw new ApiError(data.code ?? 'RETRYABLE', data.message ?? 'Request failed', response.status)
  return data as T
}
