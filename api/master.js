// Vercel serverless function: user accounts + each user's private saved master data in Upstash Redis.
// Env vars added by the Upstash integration: KV_REST_API_URL, KV_REST_API_TOKEN.
// Optional env vars: SIGNUP_CODE (invite code needed to create an account), USER_LIMIT_MB (per user, default 50), STORAGE_LIMIT_MB (all users, default 256).
const crypto = require("crypto");
const T = "lmx:total:bytes";
const LIMIT = (+process.env.STORAGE_LIMIT_MB || 256) * 1048576;
const USERLIM = (+process.env.USER_LIMIT_MB || 50) * 1048576;
const norm = o => { const r = {}; Object.keys(o).sort().forEach(c => { r[c] = String(o[c] == null ? "" : o[c]).trim(); }); return r; };
const fail = (msg, extra) => Object.assign(new Error(msg), extra || {});
const uname = v => String(v || "").trim().toLowerCase();
const okName = u => /^[a-z0-9._@+-]{3,60}$/.test(u);
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");

async function rc(cmds) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) throw new Error("Storage is not connected: KV_REST_API_URL / KV_REST_API_TOKEN are missing in the Vercel project environment variables.");
  const r = await fetch(url.replace(/\/$/, "") + "/pipeline", { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error((j && j.error) || "Storage error " + r.status);
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
async function newSession(u) { const t = crypto.randomBytes(24).toString("hex"); await rc([["SET", "lms:" + t, u, "EX", "2592000"]]); return t; }

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    /* ---- accounts ---- */
    if (b.action === "register") {
      const u = uname(b.username), pwd = String(b.password || "");
      if (!okName(u)) throw new Error("Username: 3-60 characters, only letters, numbers and . _ @ + -");
      if (pwd.length < 6) throw new Error("Password must be at least 6 characters.");
      if (process.env.SIGNUP_CODE && String(b.code || "") !== process.env.SIGNUP_CODE) throw new Error("A valid invite code is needed to create an account. Ask the owner.");
      const salt = crypto.randomBytes(16).toString("hex");
      const [ok] = await rc([["SET", "lmu:" + u, JSON.stringify({ salt, hash: hashPw(pwd, salt), created: new Date().toISOString() }), "NX"]]);
      if (ok !== "OK") throw new Error("This username is already taken.");
      return res.json({ token: await newSession(u), user: u });
    }
    if (b.action === "login") {
      const u = uname(b.username), pwd = String(b.password || "");
      if (!okName(u)) throw new Error("Wrong username or password.");
      const [fails, , rec] = await rc([["INCR", "lmf:" + u], ["EXPIRE", "lmf:" + u, "900"], ["GET", "lmu:" + u]]);
      if (fails > 8) throw new Error("Too many wrong attempts. Try again in 15 minutes.");
      if (!rec) throw new Error("Wrong username or password.");
      const o = JSON.parse(rec), h = Buffer.from(hashPw(pwd, o.salt), "hex"), g = Buffer.from(o.hash, "hex");
      if (h.length !== g.length || !crypto.timingSafeEqual(h, g)) throw new Error("Wrong username or password.");
      await rc([["DEL", "lmf:" + u]]);
      return res.json({ token: await newSession(u), user: u });
    }
    /* ---- everything below needs a signed-in user; the data namespace is the user's own name ---- */
    const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const [ws] = tok ? await rc([["GET", "lms:" + tok]]) : [null];
    if (!ws) return res.status(401).json({ error: "Please sign in." });
    const H = "lm:" + ws + ":data", M = "lm:" + ws + ":meta", B = "lm:" + ws + ":bytes";
    switch (b.action) {
      case "logout": { await rc([["DEL", "lms:" + tok]]); return res.json({ ok: true }); }
      case "status": {
        const [n, by, m, tot] = await rc([["HLEN", H], ["GET", B], ["GET", M], ["GET", T]]);
        return res.json({ user: ws, count: n || 0, bytes: Math.max(0, +by || 0), userLimit: USERLIM, total: Math.max(0, +tot || 0), limit: LIMIT, meta: m ? JSON.parse(m) : null });
      }
      case "sync": {
        const { keyCol, rows } = b;
        if (!keyCol || !Array.isArray(rows)) throw new Error("keyCol and rows are required");
        const map = new Map(); let skipped = 0, dups = 0;
        rows.forEach(r => { const k = String(r[keyCol] == null ? "" : r[keyCol]).trim(); if (!k) { skipped++; return; } if (map.has(k)) dups++; map.set(k, norm(r)); });
        const keys = [...map.keys()];
        if (!keys.length) return res.json({ new: 0, updated: 0, unchanged: 0, skipped, dups, changes: [], bytes: 0, limit: LIMIT, warn: "" });
        const o = await rc([["HMGET", H, ...keys], ["GET", B], ["GET", T], ["GET", M]]);
        const old = o[0], bytes = Math.max(0, +o[1] || 0), total = Math.max(0, +o[2] || 0), meta = o[3] ? JSON.parse(o[3]) : null;
        if (meta && meta.keyCol && meta.keyCol !== keyCol) throw new Error("Your saved data is matched by \"" + meta.keyCol + "\". Use that column, or clear your saved data first to match by \"" + keyCol + "\".");
        let neu = 0, upd = 0, same = 0, delta = 0; const writes = [], changes = [];
        keys.forEach((k, i) => {
          const nv = JSON.stringify(map.get(k)), ov = old[i];
          if (ov == null) { neu++; writes.push(k, nv); delta += k.length + nv.length; }
          else if (ov !== nv) {
            upd++; writes.push(k, nv); delta += nv.length - ov.length;
            if (changes.length < 300) {
              const a = JSON.parse(ov), n = map.get(k), cs = [];
              new Set([...Object.keys(a), ...Object.keys(n)]).forEach(c => { const x = a[c] == null ? "" : a[c], y = n[c] == null ? "" : n[c]; if (x !== y) cs.push({ c, o: x, n: y }); });
              changes.push({ key: k, cs });
            }
          } else same++;
        });
        if (bytes + delta > USERLIM) throw fail("Your personal storage limit (" + (USERLIM / 1048576).toFixed(0) + " MB) is reached: " + ((bytes + delta) / 1048576).toFixed(1) + " MB needed.", { full: true, kind: "user" });
        if (total + delta > LIMIT) throw fail("Storage limit reached: " + ((total + delta) / 1048576).toFixed(1) + " MB needed, limit is " + (LIMIT / 1048576).toFixed(0) + " MB.", { full: true, kind: "size" });
        if (writes.length) {
          const cmds = [];
          if (!meta) cmds.push(["SET", M, JSON.stringify({ keyCol, columns: [], updatedAt: new Date().toISOString() })]);
          cmds.push(["HSET", H, ...writes], ["INCRBY", B, String(delta)], ["INCRBY", T, String(delta)]);
          await rc(cmds);
        }
        const used = total + delta, pct = Math.round(used / LIMIT * 100), upct = Math.round((bytes + delta) / USERLIM * 100);
        return res.json({ new: neu, updated: upd, unchanged: same, skipped, dups, changes, bytes: bytes + delta, limit: LIMIT,
          warn: upct >= 90 ? "Your storage is " + upct + "% full. Clear old data soon." : pct >= 90 ? "All storage is " + pct + "% full. Ask the owner to clear space or upgrade the Upstash plan." : "" });
      }
      case "meta": {
        const [m] = await rc([["GET", M]]);
        const o = m ? JSON.parse(m) : {};
        const columns = [...new Set([...(o.columns || []), ...(b.columns || [])])];
        await rc([["SET", M, JSON.stringify({ keyCol: o.keyCol || b.keyCol, columns, updatedAt: new Date().toISOString() })]]);
        return res.json({ ok: true });
      }
      case "page": {
        const [r] = await rc([["HSCAN", H, String(b.cursor || "0"), "COUNT", "300"]]);
        const items = []; for (let i = 0; i < r[1].length; i += 2) items.push([r[1][i], JSON.parse(r[1][i + 1])]);
        return res.json({ cursor: String(r[0]), items });
      }
      case "clear": {
        const [by] = await rc([["GET", B]]);
        const cmds = [["DEL", H, M, B]]; if (+by > 0) cmds.push(["DECRBY", T, String(+by)]);
        await rc(cmds); return res.json({ ok: true });
      }
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
