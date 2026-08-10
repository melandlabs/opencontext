/**
 * Generic API request error
 */
export class ApiError extends Error {
  constructor(
    public message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Wrap fetch request with unified error handling
 */
async function fetchApi<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    let error = "Request failed";
    try {
      const errorData = await response.json();
      error = errorData.error || errorData.message || error;
    } catch {
      error = (await response.text()) || "Unknown error";
    }
    throw new ApiError(error, response.status);
  }

  return response.json();
}

/**
 * POST request
 */
export async function post<T>(url: string, data?: unknown): Promise<T> {
  return fetchApi<T>(url, {
    method: "POST",
    body: data ? JSON.stringify(data) : undefined,
  });
}

/**
 * GET request
 */
export async function get<T>(url: string): Promise<T> {
  return fetchApi<T>(url, { method: "GET" });
}

/**
 * PUT request
 */
export async function put<T>(url: string, data?: unknown): Promise<T> {
  return fetchApi<T>(url, {
    method: "PUT",
    body: data ? JSON.stringify(data) : undefined,
  });
}

/**
 * DELETE request
 */
export async function del<T>(url: string): Promise<T> {
  return fetchApi<T>(url, { method: "DELETE" });
}
