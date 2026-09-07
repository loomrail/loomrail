import { z } from "zod";

export type ProviderJsonRequest = {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: unknown;
  signal: AbortSignal;
};

export type ProviderJsonResponse = {
  status: number;
  body: unknown;
};

/**
 * The internal seam between provider protocol adapters and the network. Production uses fetch;
 * tests replace this function without introducing a selectable synthetic provider.
 */
export type ProviderJsonTransport = (request: ProviderJsonRequest) => Promise<ProviderJsonResponse>;

const httpStatusSchema = z.number().int().min(100).max(599);

export const fetchProviderJson: ProviderJsonTransport = async (request) => {
  const response = await fetch(request.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...request.headers },
    body: JSON.stringify(request.body),
    signal: request.signal,
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { error: { message: "The provider returned a non-JSON response" } };
    }
  }
  return { status: httpStatusSchema.parse(response.status), body };
};

export class ProviderProtocolError extends Error {
  readonly provider: string;
  readonly status: number | null;

  constructor(provider: string, message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderProtocolError";
    this.provider = provider;
    this.status = status;
  }
}
