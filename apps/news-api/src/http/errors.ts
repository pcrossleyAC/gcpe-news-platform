import { randomBytes } from "node:crypto";
import type { RequestHandler, Response } from "express";

export function emptyOk(res: Response): void {
  res.status(200).end();
}

export function problemNotFound(res: Response): void {
  const body = {
    type: "https://tools.ietf.org/html/rfc7231#section-6.5.4",
    title: "Not Found",
    status: 404,
    traceId: `|${randomBytes(4).toString("hex")}-${randomBytes(4).toString("hex")}.`,
  };
  res.status(404).set("Content-Type", "application/problem+json; charset=utf-8").send(JSON.stringify(body));
}

export function requireApiVersion(): RequestHandler {
  return (req, res, next) => {
    const raw = req.query["api-version"];
    const version = Array.isArray(raw) ? raw[0] : raw;
    if (version === undefined) {
      return void res.status(400).json({
        error: { code: "ApiVersionUnspecified", message: "An API version is required, but was not specified.", innerError: null },
      });
    }
    if (version !== "1.0" && version !== "1") {
      const uri = `${req.protocol}://${req.get("host")}${req.baseUrl}${req.path}`;
      return void res.status(400).json({
        error: {
          code: "UnsupportedApiVersion",
          message: `The HTTP resource that matches the request URI '${uri}' does not support the API version '${String(version)}'.`,
          innerError: null,
        },
      });
    }
    next();
  };
}
