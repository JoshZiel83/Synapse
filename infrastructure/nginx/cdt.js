// RFC 9842 Compression Dictionary Transport — static variant selector for
// /_next/static (njs). Pure-nginx map/try_files cannot set the correct
// Content-Encoding AND original Content-Type per variant, so this small handler
// does it explicitly.
//
// Logic: if the client advertises THIS build's dictionary ($cdt_dict_ok=1, set
// by the generated map matching the literal Available-Dictionary value) AND
// accepts dcb/dcz AND the precompressed delta file exists, serve it with the
// right Content-Encoding + Content-Type + Vary. Otherwise internal-redirect to
// @plain_static, which keeps brotli_static/zstd_static/gzip_static fallback for
// every other client (Firefox/Safari/first-visit). dcb is preferred over dcz.
import fs from "fs"

const DOCROOT = "/usr/share/nginx/web"
const IMMUTABLE = "public, max-age=31536000, immutable"
const VARY = "Accept-Encoding, Available-Dictionary"

function contentType(uri) {
  if (uri.endsWith(".js") || uri.endsWith(".mjs")) return "text/javascript"
  if (uri.endsWith(".css")) return "text/css"
  return "application/octet-stream"
}

function serve(r) {
  const dictOk = r.variables.cdt_dict_ok === "1"
  const ae = (r.headersIn["Accept-Encoding"] || "").toLowerCase()

  let coding = ""
  if (dictOk) {
    if (ae.indexOf("dcb") >= 0) coding = "dcb"
    else if (ae.indexOf("dcz") >= 0) coding = "dcz"
  }

  if (coding) {
    const variant = DOCROOT + r.uri + "." + coding
    try {
      // Throws if the delta file does not exist -> fall through to plain.
      const buf = fs.readFileSync(variant)
      r.status = 200
      r.headersOut["Content-Type"] = contentType(r.uri)
      r.headersOut["Content-Encoding"] = coding
      r.headersOut["Vary"] = VARY
      r.headersOut["Cache-Control"] = IMMUTABLE
      r.sendHeader()
      // r.send (NOT r.sendBuffer, which is stream/filter-only) accepts a Buffer
      // in an http js_content handler since njs 0.5.0.
      r.send(buf)
      r.finish()
      return
    } catch (e) {
      // no variant for this asset -> serve plain below
    }
  }

  // Non-CDT path: hand back to nginx static serving (with *_static fallback).
  r.internalRedirect("@plain_static")
}

export default { serve }
