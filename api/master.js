// Vercel serverless function: saved master data in Upstash Redis (KV_REST_API_URL / KV_REST_API_TOKEN are added by the Upstash integration)
const HASH = "lm:data", META = "lm:meta", BYTES = "lm:bytes";
const LIMIT = (+process.env.STORAGE_LIMIT_MB || 256) * 1048576;
const norm = o => { const r = {}; Object.keys(o).sort().forEach(c => { r[c] = String(o[c] == null ? "" : o[c]).trim(); }); return r; };

async function rc(cmds) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) throw new Error("Storage is not connected: KV_REST_API_URL / KV_REST_API_TOKEN are missing in the Vercel project environment variables.");
  const r = await fetch(url.replace(/\/$/, "") + "/pipeline", { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error((j && j.error) || "Storage error " + r.status);
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const pw = process.env.APP_PASSWORD;
  if (pw && req.headers["x-app-key"] !== pw) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    switch (b.action) {
      case "status": {
        const [n, by, m] = await rc([["HLEN", HASH], ["GET", BYTES], ["GET", META]]);
        return res.json({ count: n || 0, bytes: Math.max(0, +by || 0), limit: LIMIT, meta: m ? JSON.parse(m) : null, protected: !!pw });
      }
      case "sync": {
        const { keyCol, rows } = b;
        if (!keyCol || !Array.isArray(rows)) throw new Error("keyCol and rows are required");
        const map = new Map(); let skipped = 0, dups = 0;
        rows.forEach(r => { const k = String(r[keyCol] == null ? "" : r[keyCol]).trim(); if (!k) { skipped++; return; } if (map.has(k)) dups++; map.set(k, norm(r)); });
        const keys = [...map.keys()];
        let old = [], bytes = 0;
        if (keys.length) { const o = await rc([["HMGET", HASH, ...keys], ["GET", BYTES]]); old = o[0]; bytes = Math.max(0, +o[1] || 0); }
        let neu = 0, upd = 0, same = 0, delta = 0; const writes = [], changes = [];
        keys.forEach((k, i) => {
          const nv = JSON.stringify(map.get(k)), ov = old[i];
          if (ov == null) { neu++; writes.push(k, nv); delta += k.length + nv.length; }
          else if (ov !== nv) {
            upd++; writes.push(k, nv); delta += nv.length - ov.length;
            if (changes.length < 300) {
              const o = JSON.parse(ov), n = map.get(k), cs = [];
              new Set([...Object.keys(o), ...Object.keys(n)]).forEach(c => { if ((o[c] == null ? "" : o[c]) !== (n[c] == null ? "" : n[c])) cs.push({ c, o: o[c] == null ? "" : o[c], n: n[c] == null ? "" : n[c] }); });
              changes.push({ key: k, cs });
            }
          } else same++;
        });
        if (bytes + delta > LIMIT) { const e = new Error("Storage limit reached: " + ((bytes + delta) / 1048576).toFixed(1) + " MB needed, limit is " + (LIMIT / 1048576).toFixed(0) + " MB."); e.full = true; e.kind = "size"; throw e; }
        if (writes.length) await rc([["HSET", HASH, ...writes], ["INCRBY", BYTES, String(delta)]]);
        const used = bytes + delta, pct = Math.round(used / LIMIT * 100);
        return res.json({ new: neu, updated: upd, unchanged: same, skipped, dups, changes, bytes: used, limit: LIMIT,
          warn: pct >= 90 ? "Storage is " + pct + "% full (" + (used / 1048576).toFixed(1) + " of " + (LIMIT / 1048576).toFixed(0) + " MB). Clear old data or upgrade your Upstash plan soon." : "" });
      }
      case "meta": {
        const [m] = await rc([["GET", META]]);
        const o = m ? JSON.parse(m) : {};
        const columns = [...new Set([...(o.columns || []), ...(b.columns || [])])];
        await rc([["SET", META, JSON.stringify({ keyCol: b.keyCol, columns, updatedAt: new Date().toISOString() })]]);
        return res.json({ ok: true });
      }
      case "page": {
        const [r] = await rc([["HSCAN", HASH, String(b.cursor || "0"), "COUNT", "300"]]);
        const rows = []; for (let i = 1; i < r[1].length; i += 2) rows.push(JSON.parse(r[1][i]));
        return res.json({ cursor: String(r[0]), rows });
      }
      case "clear": { await rc([["DEL", HASH, META, BYTES]]); return res.json({ ok: true }); }
      default: return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    const m = String(e.message || e);
    const reqLim = /(request|command|daily|monthly|rate)/i.test(m) && /(limit|exceed|quota)/i.test(m);
    const sizeLim = /max.*(data|size|memory|storage)|OOM|out of memory|quota/i.test(m);
    const full = e.full !== undefined ? e.full : (reqLim || sizeLim);
    return res.status(full ? 507 : 500).json({ error: m, full, kind: e.kind || (reqLim ? "requests" : "size") });
  }
};
