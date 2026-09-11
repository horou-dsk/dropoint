export type HealthResponse = {
  status: 'ok';
};

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/api/health', { signal });

  if (!response.ok) {
    throw new Error(`健康检查失败：HTTP ${response.status}`);
  }

  return response.json() as Promise<HealthResponse>;
}
