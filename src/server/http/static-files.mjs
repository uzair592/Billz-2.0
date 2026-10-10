import { readFile, realpath } from "node:fs/promises";
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
    if (pathname === "/platform-admin" || pathname === "/platform-admin/") {
      pathname = "/platform-admin/index.html";
    }

    // Only POS entry page, platform-admin portal, and client modules are served.
    const isClientModule = pathname.startsWith("/src/client/");
    const isPlatformAdmin = pathname.startsWith("/platform-admin/");
    const isEntry = pathname === `/${CLIENT_ENTRY}`;
    if (!isClientModule && !isPlatformAdmin && !isEntry) {
      return reply.code(404).send({ error: "Not found." });
    }

    const filePath = normalize(join(normalizedRoot, pathname));
    const allowedRoot = isClientModule ? join(normalizedRoot, "src", "client")
      : isPlatformAdmin ? join(normalizedRoot, "platform-admin") : normalizedRoot;
    const rootWithSep = allowedRoot + sep;
    if (!filePath.startsWith(rootWithSep) || (isEntry && filePath !== join(normalizedRoot, CLIENT_ENTRY))) {
      return reply.code(403).send({ error: "Forbidden." });
    }

    try {
      const canonicalRoot = await realpath(allowedRoot);
      const canonicalFile = await realpath(filePath);
      if (!canonicalFile.startsWith(canonicalRoot + sep)) {
        return reply.code(403).send({ error: "Forbidden." });
      }
      let body = await readFile(canonicalFile);
      if (isEntry) body = Buffer.from(body.toString("utf8").replace("<head>", "<head><script>window.BILLZ_MANAGED = true;</script>"));
      return reply
        .header("Content-Type", MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream")
        .header("Cache-Control", "no-store")
        .send(body);
    } catch {
      return reply.code(404).send({ error: "Not found." });
    }
  };
}
