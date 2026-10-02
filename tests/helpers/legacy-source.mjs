import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(currentDirectory, "..", "..");
export const legacyAppPath = path.join(
  projectRoot,
  "Fast_Food_POS_Custom_Bill_Header_XXXL.html",
);

export async function readLegacyApp() {
  return readFile(legacyAppPath, "utf8");
}

export function extractInlineScript(html) {
  const openingTag = html.lastIndexOf("<script>");
  const closingTag = html.lastIndexOf("</script>");

  if (openingTag === -1 || closingTag <= openingTag) {
    throw new Error("The legacy POS inline script could not be located.");
  }

  return html.slice(openingTag + "<script>".length, closingTag);
}

export function extractDeclaration(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);

  if (start === -1 || end === -1) {
    throw new Error(`Could not extract legacy declaration: ${startMarker}`);
  }

  return source.slice(start, end).trim();
}
