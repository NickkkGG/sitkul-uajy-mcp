import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";

type CanvaFormat = "pdf" | "pptx";

type StoredToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

type PendingAuthorization = {
  authorizationUrl: string;
  callbackServer: Server;
  codeVerifier: string;
  state: string;
};

type EncryptedToken = { version: 1; iv: string; tag: string; ciphertext: string };

const CANVA_API = "https://api.canva.com/rest/v1";
const CANVA_AUTHORIZE = "https://www.canva.com/api/oauth/authorize";
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function isCanvaHost(hostname: string): boolean {
  return hostname === "canva.com" || hostname.endsWith(".canva.com") || hostname === "canva.link";
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Configure the Canva OAuth values in your local .env first.`);
  return value;
}

function defaultTokenPath(): string {
  const root = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? process.cwd();
  return resolve(root, "SitkulUajyMcp", "canva-oauth.enc");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class CanvaClient {
  private pending: PendingAuthorization | undefined;

  private config(): { clientId: string; clientSecret: string; redirectUri: URL; tokenPath: string; encryptionKey: Buffer } {
    const redirectUri = new URL(requireEnvironment("CANVA_REDIRECT_URI"));
    if (redirectUri.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(redirectUri.hostname)) {
      throw new Error("CANVA_REDIRECT_URI must be a local HTTP callback URL, such as http://127.0.0.1:3434/canva/oauth/callback.");
    }
    if (!redirectUri.port) throw new Error("CANVA_REDIRECT_URI must include a fixed local port.");
    const encryptionKey = Buffer.from(requireEnvironment("CANVA_TOKEN_ENCRYPTION_KEY"), "base64");
    if (encryptionKey.length !== 32) throw new Error("CANVA_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    return {
      clientId: requireEnvironment("CANVA_CLIENT_ID"),
      clientSecret: requireEnvironment("CANVA_CLIENT_SECRET"),
      redirectUri,
      tokenPath: resolve(process.env.CANVA_TOKEN_STORE_PATH ?? defaultTokenPath()),
      encryptionKey,
    };
  }

  private async readToken(): Promise<StoredToken | undefined> {
    const config = this.config();
    try {
      const encrypted = JSON.parse(await readFile(config.tokenPath, "utf8")) as EncryptedToken;
      if (encrypted.version !== 1) throw new Error("Unsupported saved Canva token format.");
      const decipher = createDecipheriv("aes-256-gcm", config.encryptionKey, Buffer.from(encrypted.iv, "base64"));
      decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]);
      const token = JSON.parse(plaintext.toString("utf8")) as StoredToken;
      if (!token.accessToken || !token.refreshToken || !token.expiresAt) throw new Error("Saved Canva token is incomplete.");
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Could not read the saved Canva connection: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async saveToken(token: StoredToken): Promise<void> {
    const config = this.config();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(token), "utf8"), cipher.final()]);
    const encrypted: EncryptedToken = {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    await mkdir(dirname(config.tokenPath), { recursive: true });
    await writeFile(config.tokenPath, JSON.stringify(encrypted), { encoding: "utf8", mode: 0o600 });
  }

  private tokenFromResponse(payload: unknown, previous?: StoredToken): StoredToken {
    const value = payload as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof value.access_token !== "string" || !value.access_token) throw new Error("Canva OAuth did not return an access token.");
    const refreshToken = typeof value.refresh_token === "string" ? value.refresh_token : previous?.refreshToken;
    if (!refreshToken) throw new Error("Canva OAuth did not return a refresh token. Reconnect Canva and approve offline access.");
    const expiresIn = typeof value.expires_in === "number" ? value.expires_in : 3_600;
    return { accessToken: value.access_token, refreshToken, expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString() };
  }

  private async exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<void> {
    const config = this.config();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: config.redirectUri.href,
    });
    const response = await fetch(`${CANVA_API}/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`Canva OAuth token exchange failed (HTTP ${response.status}).`);
    await this.saveToken(this.tokenFromResponse(payload));
  }

  private async refreshToken(token: StoredToken): Promise<StoredToken> {
    const config = this.config();
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken });
    const response = await fetch(`${CANVA_API}/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`Canva token refresh failed (HTTP ${response.status}). Reconnect Canva.`);
    const refreshed = this.tokenFromResponse(payload, token);
    await this.saveToken(refreshed);
    return refreshed;
  }

  private async accessToken(): Promise<string> {
    const token = await this.readToken();
    if (!token) throw new Error("Canva is not connected. Run connect_canva, open its authorization URL, and complete the one-time login.");
    if (Date.parse(token.expiresAt) - Date.now() > TOKEN_REFRESH_SKEW_MS) return token.accessToken;
    return (await this.refreshToken(token)).accessToken;
  }

  private async api(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const response = await fetch(`${CANVA_API}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${await this.accessToken()}` },
    });
    if (response.status !== 401 || retried) return response;
    const token = await this.readToken();
    if (!token) return response;
    await this.refreshToken(token);
    return this.api(path, init, true);
  }

  async connectionStatus(): Promise<{ configured: boolean; connected: boolean; callbackUrl?: string }> {
    try {
      const config = this.config();
      return { configured: true, connected: Boolean(await this.readToken()), callbackUrl: config.redirectUri.href };
    } catch {
      return { configured: false, connected: false };
    }
  }

  async beginConnection(): Promise<{ authorizationUrl: string; callbackUrl: string }> {
    const config = this.config();
    if (this.pending) return { authorizationUrl: this.pending.authorizationUrl, callbackUrl: config.redirectUri.href };
    const codeVerifier = base64url(randomBytes(48));
    const state = randomUUID();
    const authorizationUrl = new URL(CANVA_AUTHORIZE);
    authorizationUrl.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri.href,
      response_type: "code",
      scope: "design:content:read design:meta:read",
      state,
      code_challenge: base64url(createHash("sha256").update(codeVerifier).digest()),
      code_challenge_method: "S256",
    }).toString();

    const callbackServer = createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? "/", config.redirectUri);
      if (requestUrl.pathname !== config.redirectUri.pathname) {
        response.writeHead(404).end("Not found");
        return;
      }
      const code = requestUrl.searchParams.get("code");
      const returnedState = requestUrl.searchParams.get("state");
      const providerError = requestUrl.searchParams.get("error");
      try {
        if (providerError) throw new Error(`Canva authorization was cancelled or denied: ${providerError}`);
        if (!code || returnedState !== state) throw new Error("Invalid Canva OAuth callback. Start connect_canva again.");
        await this.exchangeAuthorizationCode(code, codeVerifier);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<h1>Canva tersambung</h1><p>Kamu boleh menutup halaman ini dan kembali ke Codex.</p>");
      } catch (error) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(`<h1>Koneksi Canva gagal</h1><p>${error instanceof Error ? error.message : "Unknown error"}</p>`);
      } finally {
        this.pending = undefined;
        callbackServer.close();
      }
    });
    await new Promise<void>((resolve, reject) => {
      callbackServer.once("error", reject);
      callbackServer.listen(Number(config.redirectUri.port), config.redirectUri.hostname, resolve);
    });
    this.pending = { authorizationUrl: authorizationUrl.href, callbackServer, codeVerifier, state };
    return { authorizationUrl: authorizationUrl.href, callbackUrl: config.redirectUri.href };
  }

  private async designIdFromUrl(canvaUrl: string): Promise<string> {
    let parsed = new URL(canvaUrl);
    if (!isCanvaHost(parsed.hostname)) throw new Error("Only Canva URLs returned by list_materials may be exported.");
    if (parsed.hostname === "canva.link") {
      const response = await fetch(parsed, { redirect: "follow" });
      parsed = new URL(response.url);
      await response.body?.cancel();
    }
    if (!isCanvaHost(parsed.hostname)) throw new Error("The Canva link redirected outside Canva and was blocked.");
    const designId = /^\/design\/([^/]+)/.exec(parsed.pathname)?.[1];
    if (!designId) throw new Error("Could not find a Canva design ID in this link.");
    return designId;
  }

  private async uniquePath(directory: string, basename: string): Promise<string> {
    for (let index = 0; index < 1_000; index += 1) {
      const suffix = index === 0 ? "" : `-${index}`;
      const path = resolve(directory, `${basename}${suffix}`);
      try {
        await readFile(path, { flag: "r" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
        throw error;
      }
    }
    throw new Error("Could not allocate a unique Canva download filename.");
  }

  async downloadDesign(canvaUrl: string, format: CanvaFormat, outputDirectory: string): Promise<{ designId: string; format: CanvaFormat; paths: string[] }> {
    const designId = await this.designIdFromUrl(canvaUrl);
    const started = await this.api("/exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ design_id: designId, format: { type: format } }),
    });
    let payload = await started.json().catch(() => undefined) as { job?: { id?: string; status?: string; urls?: string[]; error?: { message?: string } } } | undefined;
    if (!started.ok || !payload?.job?.id) throw new Error(`Canva export could not start (HTTP ${started.status}).`);
    const jobId = payload.job.id;

    for (let attempt = 0; attempt < 20 && payload.job.status === "in_progress"; attempt += 1) {
      await sleep(1_000);
      const status = await this.api(`/exports/${encodeURIComponent(jobId)}`);
      payload = await status.json().catch(() => undefined) as typeof payload;
      if (!status.ok || !payload?.job) throw new Error(`Canva export status check failed (HTTP ${status.status}).`);
    }
    if (payload?.job?.status !== "success" || !payload.job.urls?.length) {
      throw new Error(payload?.job?.error?.message ?? "Canva did not complete the export. The design may not permit export.");
    }

    const directory = resolve(outputDirectory);
    await mkdir(directory, { recursive: true });
    const paths: string[] = [];
    for (const [index, url] of payload.job.urls.entries()) {
      const endpoint = new URL(url);
      if (!isCanvaHost(endpoint.hostname)) throw new Error("Canva returned an unexpected download host.");
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`Canva download failed (HTTP ${response.status}).`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("Canva export is larger than the 100 MB safety limit.");
      const path = await this.uniquePath(directory, `canva-${designId}-${index + 1}.${format}`);
      await writeFile(path, bytes, { flag: "wx" });
      paths.push(path);
    }
    return { designId, format, paths };
  }
}
