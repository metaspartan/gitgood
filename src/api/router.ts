import type { Auth } from "../auth/service.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteContext {
  request: Request;
  url: URL;
  params: Readonly<Record<string, string>>;
  auth: Auth;
  ip: string;
}

export type Handler = (ctx: RouteContext) => Promise<Response> | Response;

interface CompiledRoute {
  method: HttpMethod;
  segments: readonly string[];
  handler: Handler;
  staticRoute: boolean;
}

export interface MatchResult {
  handler: Handler;
  params: Record<string, string>;
}

export class Router {
  private readonly byMethod = new Map<HttpMethod, CompiledRoute[]>();

  private readonly registered = new Set<string>();

  add(method: HttpMethod, path: string, handler: Handler): this {
    const key = `${method} ${path}`;
    if (this.registered.has(key)) {
      throw new Error(`Duplicate route registration: ${key}`);
    }
    this.registered.add(key);

    const segments = path.split("/").filter(Boolean);
    const route: CompiledRoute = {
      method,
      segments,
      handler,
      staticRoute: segments.every((segment) => !segment.startsWith(":")),
    };
    const list = this.byMethod.get(method) ?? [];
    list.push(route);
    list.sort((a, b) => Number(b.staticRoute) - Number(a.staticRoute));
    this.byMethod.set(method, list);
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.add("GET", path, handler);
  }
  post(path: string, handler: Handler): this {
    return this.add("POST", path, handler);
  }
  put(path: string, handler: Handler): this {
    return this.add("PUT", path, handler);
  }
  patch(path: string, handler: Handler): this {
    return this.add("PATCH", path, handler);
  }
  delete(path: string, handler: Handler): this {
    return this.add("DELETE", path, handler);
  }

  match(method: string, pathname: string): MatchResult | null {
    const routes = this.byMethod.get(method as HttpMethod);
    if (!routes) return null;
    const parts = pathname.split("/").filter(Boolean);

    for (const route of routes) {
      if (route.segments.length !== parts.length) continue;
      if (route.staticRoute) {
        let equal = true;
        for (let i = 0; i < parts.length; i++) {
          if (route.segments[i] !== parts[i]) {
            equal = false;
            break;
          }
        }
        if (equal) return { handler: route.handler, params: {} };
        continue;
      }
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < parts.length; i++) {
        const pattern = route.segments[i];
        const value = parts[i];
        if (pattern === undefined || value === undefined) {
          matched = false;
          break;
        }
        if (pattern.startsWith(":")) {
          params[pattern.slice(1)] = decodeURIComponent(value);
        } else if (pattern !== value) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }

  hasPath(pathname: string): boolean {
    for (const method of this.byMethod.keys()) {
      if (this.match(method, pathname)) return true;
    }
    return false;
  }

  get size(): number {
    let total = 0;
    for (const routes of this.byMethod.values()) total += routes.length;
    return total;
  }

  registrations(): string[] {
    return [...this.registered].sort();
  }
}
