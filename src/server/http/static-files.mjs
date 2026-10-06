import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serves the legacy POS client (the single HTML page and its
 * ES-module client code) from the application container.
 *
 * The client is a static asset: one HTML file plus the modules under
 * src/client. They are served with no-store so a deployed build is
 * never cached across a redeployment.
 *
 * Path traversal is prevented by confining every resolved path to the
 * application root.
 */

const CLIENT_ENTRY = "Fast_Food_POS_Custom_Bill_Header_XXXL.html";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function appRoot() {
  // src/server/http/static-files.mjs -> <root>
  const here = fileURLToPath(new URL(".", import.meta.url));
  return normalize(join(here, "..", "..", ".."));
}

export function createStaticFileHandler({ root = appRoot() } = {}) {
  const normalizedRoot = normalize(root);

  return async function serveStatic(request, reply) {
    const url = new URL(request.url, "http://internal");
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return reply.code(400).send({ error: "Invalid request path." });
    }

    if (pathname === "/" || pathname === "") {
      pathname = `/${CLIENT_ENTRY}`;
    }

    // Only the POS entry page and client modules are served. Anything
    // else is left to the API routes (which 404).
    const isClientModule = pathname.startsWith("/src/client/");
    const isEntry = pathname === `/${CLIENT_ENTRY}`;
    if (!isClientModule && !isEntry) {
      return reply.code(404).send({ error: "Not found." });
    }

    const filePath = normalize(join(normalizedRoot, pathname));
    const rootWithSep = normalizedRoot.endsWith(sep)
      ? normalizedRoot
      : normalizedRoot + sep;
    if (!filePath.startsWith(rootWithSep) && filePath !== normalizedRoot) {
      return reply.code(403).send({ error: "Forbidden." });
    }

    try {
      const body = await readFile(filePath);
      return reply
        .header("Content-Type", MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream")
        .header("Cache-Control", "no-store")
        .send(body);
    } catch {
      return reply.code(404).send({ error: "Not found." });
    }
  };
}
