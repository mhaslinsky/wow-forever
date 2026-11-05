import type { Snapshot } from "./reader.mts";

export async function uploadSnapshot(
  endpoint: URL,
  token: string,
  snapshot: Snapshot,
  request: typeof fetch = fetch,
) {
  const response = await request(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  let body: { outcome?: string; error?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    body = { error: "InvalidResponseError" };
  }
  return { ...body, status: response.status };
}
