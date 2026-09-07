import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

export type LoopbackAuthCallback = {
  url: URL;
  authorize(url: URL): void;
  expectState(state: string): void;
  waitForCode(signal: AbortSignal, timeoutMs: number): Promise<string>;
  close(reason?: Error): Promise<void>;
};

export async function openLoopbackAuthCallback(configuredUrl: string | undefined): Promise<LoopbackAuthCallback> {
  const configured = configuredUrl ? new URL(configuredUrl) : new URL("http://127.0.0.1/callback");
  if (configured.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(configured.hostname)) {
    throw new Error("oauth callback must use a local http loopback address");
  }
  if (configured.username || configured.password || configured.search || configured.hash) {
    throw new Error("oauth callback must not contain credentials, query parameters, or a fragment");
  }
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  let expectedState: string | undefined;
  let settled = false;
  let closeTask: Promise<void> | undefined;
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: Error) => void = () => {};
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rejectCode = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });
  void code.catch(() => {});
  server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== configured.pathname) {
      response.writeHead(404).end("not found");
      return;
    }
    const error = requestUrl.searchParams.get("error");
    const authorizationCode = requestUrl.searchParams.get("code");
    if (error) {
      response.writeHead(400, { "content-type": "text/plain" }).end(`authorization failed: ${error}`);
      rejectCode(new Error(`oauth authorization failed: ${error}`));
      return;
    }
    const returnedState = requestUrl.searchParams.get("state");
    if (!expectedState || returnedState !== expectedState) {
      response.writeHead(400, { "content-type": "text/plain" }).end("authorization state mismatch");
      rejectCode(new Error("oauth authorization state mismatch"));
      return;
    }
    if (!authorizationCode) {
      response.writeHead(400, { "content-type": "text/plain" }).end("authorization code missing");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end("<html><body><h1>farai connected</h1><p>you can close this window and return to farai.</p></body></html>");
    resolveCode(authorizationCode);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const requestedPort = configured.port ? Number(configured.port) : 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const listener = server!;
      const onError = (error: Error) => {
        listener.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        listener.off("error", onError);
        resolve();
      };
      listener.once("error", onError);
      listener.once("listening", onListening);
      listener.listen(requestedPort, configured.hostname === "localhost" ? "127.0.0.1" : configured.hostname);
    });
  } catch (error) {
    rejectCode(error instanceof Error ? error : new Error(String(error)));
    for (const socket of sockets) socket.destroy();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    const failure = new Error("oauth callback listener failed to bind");
    rejectCode(failure);
    for (const socket of sockets) socket.destroy();
    await closeHttpServer(server);
    throw failure;
  }
  configured.port = String(address.port);
  return {
    url: configured,
    authorize(url) {
      openExternalUrl(url.toString());
    },
    expectState(state) {
      expectedState = state;
    },
    async waitForCode(signal, timeoutMs) {
      return await withDeadline(code, timeoutMs, "oauth authorization", signal);
    },
    async close(reason) {
      if (closeTask) return await closeTask;
      closeTask = (async () => {
        rejectCode(reason ?? new Error("oauth callback closed"));
        const listener = server;
        server = undefined;
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        if (listener) await closeHttpServer(listener);
      })();
      await closeTask;
    }
  };
}

export async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    try {
      server.close(done);
      server.closeAllConnections?.();
      timer = setTimeout(done, 500);
      timer.unref?.();
    } catch {
      done();
    }
  });
}

export function openExternalUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

export async function withDeadline<T>(task: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  try {
    const deadlines: Promise<T>[] = [task, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    })];
    if (signal) {
      deadlines.push(new Promise<T>((_, reject) => {
        const abort = () => reject(deadlineAbortError(label, signal));
        signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
      }));
    }
    return await Promise.race(deadlines);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort?.();
  }
}

export function deadlineAbortError(label: string, signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(`${label} cancelled${reason === undefined ? "" : `: ${String(reason)}`}`);
}
