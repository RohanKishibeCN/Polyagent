import { spawn } from "child_process";

const CURL =
  process.platform === "darwin"
    ? "/opt/homebrew/opt/curl/bin/curl"
    : process.platform === "win32"
      ? "C:\\Windows\\System32\\curl.exe"
      : "/usr/bin/curl";

function curlFetch(
  url: string | URL,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const args = ["-s", "-L"];
    for (const [key, value] of Object.entries(headers ?? {})) {
      args.push("-H", `${key}: ${value}`);
    }
    args.push(url.toString());

    const proc = spawn(CURL, args, { stdio: ["ignore", "pipe", "pipe"] });

    if (signal) {
      signal.addEventListener("abort", () => proc.kill());
    }

    let stdout = "";
    let stderr = "";

    proc.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    proc.on("close", (exitCode: number | null) => {
      if (signal?.aborted) return;
      if (exitCode !== 0) {
        reject(new Error(`curl exited ${exitCode}: ${stderr}`));
        return;
      }
      resolve(new Response(stdout, { status: 200 }));
    });

    proc.on("error", reject);
  });
}

export async function fetchWithRetry<T = Response>(
  url: string | URL,
  params?: {
    options?: RequestInit;
    resolveWhen?: (res: Response) => Promise<T>;
    totalRetry?: number;
    retryBackOff?: (currentRetry: number) => number;
    _currentRetry?: number;
    useCurl?: boolean;
    abort?: AbortSignal;
    onError?: (err: unknown) => void;
  },
): Promise<T> {
  function sleep(millis: number) {
    return new Promise((r) => setTimeout(r, millis));
  }

  const _params = params ?? {};
  const retryTimes = _params.totalRetry ?? 3;
  const currentRetry = _params._currentRetry ?? 0;

  if (_params.abort?.aborted) return undefined as T;

  try {
    const res = _params.useCurl
      ? await curlFetch(
          url,
          _params.options?.headers as Record<string, string>,
          _params.abort,
        )
      : await fetch(url, _params.options);
    if (!res.ok) {
      const obj = await res.text();
      throw Error(obj);
    }
    if (params?.resolveWhen) {
      return await params.resolveWhen(res);
    } else {
      return res as T;
    }
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError")
      return undefined as T;

    if (params?.onError) params.onError(e);

    if (retryTimes - currentRetry <= 0) throw e;
    let delay: number;
    if (params?.retryBackOff) {
      delay = params.retryBackOff(currentRetry);
    } else {
      delay = 1000 * Math.pow(2, currentRetry);
    }
    if (_params.abort?.aborted) return undefined as T;
    await sleep(delay);
    return await fetchWithRetry(url, {
      ..._params,
      _currentRetry: currentRetry + 1,
    });
  }
}
