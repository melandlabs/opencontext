export const COMPOSIO_GOOGLE_CALENDAR_TOOLKIT = "googlecalendar";
export const COMPOSIO_GOOGLE_MEET_TOOLKIT = "googlemeet";

export type ComposioToolkitSlug =
  | typeof COMPOSIO_GOOGLE_CALENDAR_TOOLKIT
  | typeof COMPOSIO_GOOGLE_MEET_TOOLKIT;

export type ComposioCredentials = {
  provider?: "composio" | "google_oauth" | null;
  composioConnectedAccountId?: string | null;
  composioCalendarAuthConfigId?: string | null;
  composioAuthConfigId?: string | null;
  composioUserId?: string | null;
};

export type ComposioConnectLink = {
  redirectUrl: string;
  connectedAccountId?: string | null;
  linkToken?: string | null;
  expiresAt?: string | null;
  authConfigId: string;
};

export class ComposioIntegrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ComposioIntegrationError";
  }
}

type FetchLike = typeof fetch;

type ComposioClientOptions = {
  apiKey?: string | null;
  baseUrl?: string | null;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
};

type ComposioAuthConfig = {
  id?: string;
  status?: string | null;
  auth_scheme?: string | null;
  is_composio_managed?: boolean | null;
  type?: string | null;
  toolkit?: {
    slug?: string | null;
  } | null;
};

type ComposioAuthConfigResponse = {
  items?: ComposioAuthConfig[];
  auth_config?: ComposioAuthConfig;
  id?: string;
};

type ComposioConnectedAccount = {
  id?: string;
  status?: string | null;
  state?: string | null;
  user_id?: string | null;
  client_unique_user_id?: string | null;
  account?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
  connection_data?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
};

type ComposioProxyResponse<T> = {
  data?: T;
  status?: number;
  status_code?: number;
  error?: unknown;
};

type ProxyRequestInput = {
  connectedAccountId: string;
  endpoint: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
};

export class ComposioClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly env: Record<string, string | undefined>;

  constructor(options: ComposioClientOptions = {}) {
    this.env = options.env ?? process.env;
    const apiKey = options.apiKey ?? this.env.COMPOSIO_API_KEY;

    if (!apiKey) {
      throw new ComposioIntegrationError(
        "bad_request:composio",
        "Composio integration is not configured. Please set COMPOSIO_API_KEY.",
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = (
      options.baseUrl ??
      this.env.COMPOSIO_BASE_URL ??
      "https://backend.composio.dev/api/v3.1"
    ).replace(/\/+$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Resolve a usable auth config id for the toolkit. Prefers an env-pinned id,
   * then an existing reusable managed config, and only creates one as a last
   * resort. The create path has a side effect and is not atomic: concurrent
   * first-time connects (e.g. multiple tabs) with no env id and no existing
   * config can each create a managed config. Subsequent calls converge via the
   * reuse branch, so the worst case is a few duplicate (harmless) configs.
   * Set COMPOSIO_GOOGLE_*_AUTH_CONFIG_ID in production to avoid this entirely.
   */
  async resolveAuthConfigId(toolkitSlug: ComposioToolkitSlug) {
    const configuredId = readAuthConfigIdFromEnv(toolkitSlug, this.env);
    if (configuredId) return configuredId;

    const existingConfigs = await this.listAuthConfigs(toolkitSlug);
    const reusableConfig = existingConfigs.find(
      (config) =>
        config.id &&
        config.is_composio_managed !== false &&
        config.auth_scheme === "OAUTH2" &&
        config.status !== "DISABLED",
    );

    if (reusableConfig?.id) {
      return reusableConfig.id;
    }

    return this.createManagedOauthAuthConfig(toolkitSlug);
  }

  async createConnectLink({
    toolkitSlug,
    userId,
    callbackUrl,
    authConfigId,
  }: {
    toolkitSlug: ComposioToolkitSlug;
    userId: string;
    callbackUrl: string;
    authConfigId?: string | null;
  }): Promise<ComposioConnectLink> {
    const resolvedAuthConfigId =
      authConfigId ?? (await this.resolveAuthConfigId(toolkitSlug));
    const response = await this.request<Record<string, unknown>>(
      "/connected_accounts/link",
      {
        method: "POST",
        body: JSON.stringify({
          auth_config_id: resolvedAuthConfigId,
          user_id: userId,
          callback_url: callbackUrl,
        }),
      },
    );

    const redirectUrl =
      getString(response, "redirect_url") ??
      getString(response, "redirectUrl") ??
      getString(response, "url");

    if (!redirectUrl) {
      throw new ComposioIntegrationError(
        "bad_response:composio",
        "Composio did not return an authorization URL.",
      );
    }

    return {
      redirectUrl,
      connectedAccountId:
        getString(response, "connected_account_id") ??
        getString(response, "connectedAccountId") ??
        null,
      linkToken:
        getString(response, "link_token") ?? getString(response, "linkToken"),
      expiresAt:
        getString(response, "expires_at") ?? getString(response, "expiresAt"),
      authConfigId: resolvedAuthConfigId,
    };
  }

  async getConnectedAccount(connectedAccountId: string) {
    return this.request<ComposioConnectedAccount>(
      `/connected_accounts/${encodeURIComponent(connectedAccountId)}`,
      { method: "GET" },
    );
  }

  async proxy<T>(input: ProxyRequestInput): Promise<T> {
    const response = await this.request<ComposioProxyResponse<T>>(
      "/tools/execute/proxy",
      {
        method: "POST",
        body: JSON.stringify({
          connected_account_id: input.connectedAccountId,
          endpoint: input.endpoint,
          method: input.method,
          body: input.body,
        }),
      },
    );

    const status = response.status ?? response.status_code;
    if (status && status >= 400) {
      throw new ComposioIntegrationError(
        "bad_response:composio_proxy",
        `Composio proxy request failed with status ${status}.`,
        status,
      );
    }

    if (response.error) {
      throw new ComposioIntegrationError(
        "bad_response:composio_proxy",
        getComposioErrorMessage(response.error),
        status,
      );
    }

    return response.data as T;
  }

  private async listAuthConfigs(toolkitSlug: ComposioToolkitSlug) {
    const params = new URLSearchParams({
      toolkit_slug: toolkitSlug,
      limit: "100",
    });
    const response = await this.request<ComposioAuthConfigResponse>(
      `/auth_configs?${params.toString()}`,
      { method: "GET" },
    );
    return response.items ?? [];
  }

  private async createManagedOauthAuthConfig(toolkitSlug: ComposioToolkitSlug) {
    const response = await this.request<ComposioAuthConfigResponse>(
      "/auth_configs",
      {
        method: "POST",
        body: JSON.stringify({
          toolkit: {
            slug: toolkitSlug,
          },
        }),
      },
    );

    const id = response.auth_config?.id ?? response.id;
    if (!id) {
      throw new ComposioIntegrationError(
        "bad_response:composio",
        `Composio did not return an auth config id for ${toolkitSlug}.`,
      );
    }
    return id;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    const data = text ? safeParseJson(text) : {};

    if (!response.ok) {
      throw new ComposioIntegrationError(
        "bad_response:composio",
        getComposioErrorMessage(data),
        response.status,
      );
    }

    return data as T;
  }
}

export function isComposioConfigured(
  env: Record<string, string | undefined> = process.env,
) {
  return Boolean(env.COMPOSIO_API_KEY);
}

export function isComposioCredentials(
  credentials: ComposioCredentials | null | undefined,
) {
  return Boolean(
    credentials?.provider === "composio" ||
    credentials?.composioConnectedAccountId,
  );
}

function readAuthConfigIdFromEnv(
  toolkitSlug: ComposioToolkitSlug,
  env: Record<string, string | undefined>,
) {
  const names =
    toolkitSlug === COMPOSIO_GOOGLE_CALENDAR_TOOLKIT
      ? [
          "COMPOSIO_GOOGLE_CALENDAR_AUTH_CONFIG_ID",
          "COMPOSIO_CALENDAR_AUTH_CONFIG_ID",
        ]
      : ["COMPOSIO_GOOGLE_MEET_AUTH_CONFIG_ID", "COMPOSIO_MEET_AUTH_CONFIG_ID"];

  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }

  return null;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function getString(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getComposioErrorMessage(error: unknown) {
  if (!error) return "Composio request failed.";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message =
      record.message ??
      record.error ??
      record.detail ??
      record.details ??
      record.title;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return "Composio request failed.";
}
