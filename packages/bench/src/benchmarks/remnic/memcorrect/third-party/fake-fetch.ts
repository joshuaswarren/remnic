/**
 * Fake fetch helper for deterministic third-party adapter smoke tests.
 *
 * No network is touched. Each test registers canned responses keyed by
 * method+URL substring; the fake records every request so tests can assert
 * on headers, body, and endpoint shape.
 */

import assert from "node:assert/strict";
import type { FetchLike } from "./shared.js";

interface FakeResponse {
  status?: number;
  body?: unknown;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Built fake fetch: the callable transport plus assertion helpers. */
export interface FakeFetch {
  fetch: FetchLike;
  requests: RecordedRequest[];
  assertRequest: (
    method: string,
    urlSubstring: string,
    check: (req: RecordedRequest) => void,
  ) => void;
  countRequests: (method: string, urlSubstring: string) => number;
}

/**
 * Minimal Response-like object that satisfies what `httpJson` reads:
 * `.ok`, `.status`, and `.text()`.
 */
class FakeResponseImpl {
  readonly status: number;
  readonly ok: boolean;
  private readonly textContent: string;

  constructor(response: FakeResponse) {
    this.status = response.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.textContent =
      response.body === undefined || response.body === null
        ? ""
        : typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body);
  }

  async text(): Promise<string> {
    return this.textContent;
  }
}

/**
 * Builder for a fake fetch that matches requests and returns canned responses.
 * Responses are queued FIFO per matcher; if a matcher runs out of queued
 * responses it repeats the last one.
 */
export class FakeFetchBuilder {
  private readonly matchers: Array<{
    method: string;
    urlSubstring: string;
    responses: FakeResponse[];
    index: number;
  }> = [];
  readonly requests: RecordedRequest[] = [];

  /** Queue canned responses for requests matching method + URL substring. */
  when(
    method: string,
    urlSubstring: string,
    ...responses: FakeResponse[]
  ): this {
    this.matchers.push({
      method: method.toUpperCase(),
      urlSubstring,
      responses,
      index: 0,
    });
    return this;
  }

  /** Build the fetch function with attached assertion helpers. */
  build(): FakeFetch {
    const matchers = this.matchers;
    const requests = this.requests;
    const fetchFn = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<FakeResponseImpl> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      const rawHeaders = init?.headers;
      if (rawHeaders) {
        if (rawHeaders instanceof Headers) {
          rawHeaders.forEach((v, k) => {
            headers[k] = v;
          });
        } else if (Array.isArray(rawHeaders)) {
          for (const [k, v] of rawHeaders) headers[k] = v;
        } else {
          Object.assign(headers, rawHeaders);
        }
      }
      let body: unknown = undefined;
      if (init?.body) {
        try {
          body = JSON.parse(init.body as string);
        } catch {
          body = init.body;
        }
      }
      requests.push({ method, url, headers, body });

      for (const m of matchers) {
        if (m.method === method && url.includes(m.urlSubstring)) {
          const response =
            m.responses[Math.min(m.index, m.responses.length - 1)];
          m.index++;
          return new FakeResponseImpl(response);
        }
      }
      // Default: 404 so unmatched requests are loud in tests.
      return new FakeResponseImpl({ status: 404, body: { error: "no mock" } });
    }) as unknown as FetchLike;

    return {
      fetch: fetchFn,
      requests,
      assertRequest: this.assertRequest.bind(this),
      countRequests: this.countRequests.bind(this),
    };
  }

  /** Assert the last request matching method+url had a given body field. */
  assertRequest(
    method: string,
    urlSubstring: string,
    check: (req: RecordedRequest) => void,
  ): void {
    const found = this.requests.find(
      (r) => r.method === method.toUpperCase() && r.url.includes(urlSubstring),
    );
    assert.ok(found, `expected a ${method} request to ${urlSubstring}`);
    check(found);
  }

  /** Count requests matching method+url. */
  countRequests(method: string, urlSubstring: string): number {
    return this.requests.filter(
      (r) => r.method === method.toUpperCase() && r.url.includes(urlSubstring),
    ).length;
  }
}
