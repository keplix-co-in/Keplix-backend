/**
 * One-time import of existing Keplix accounts into Supabase Auth
 * (2026-11 auth migration). Safe to re-run: rows that already have a
 * supabaseId are skipped, and an email Supabase already knows is linked
 * instead of re-created.
 *
 * - Existing bcrypt hashes are passed as `password_hash`, so everyone keeps
 *   their password. Google-only rows (password "") get no password.
 *   Old Django pbkdf2 hashes cannot be imported: those people must use
 *   "Forgot password" once (counted as needsReset).
 * - After a row is linked its password column is set to NULL: from then on
 *   Supabase Auth is the only place a password (hash) lives.
 * - A User and an Admin with the same email share ONE Supabase user.
 * - Emails are imported as confirmed (they were verified by the old flows).
 *
 * Usage (needs DATABASE_URL, SUPABASE_URL, SUPABASE_SECRET_KEY):
 *   node scripts/importUsersToSupabase.js            # dry run: counts only
 *   node scripts/importUsersToSupabase.js --apply    # really import
 */
import prisma from "../util/prisma.js";
import { SUPABASE_URL } from "../util/supabaseAuth.js";

const APPLY = process.argv.includes("--apply");
const ADMIN = `${SUPABASE_URL}/auth/v1/admin`;
const BCRYPT = /^\$2[aby]\$\d{2}\$.{53}$/;

const headers = () => {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY is not set");
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
};

/** email -> Supabase id for every user already in Supabase Auth. */
const loadExisting = async () => {
  const map = new Map();
  for (let page = 1; ; page++) {
    const res = await fetch(`${ADMIN}/users?page=${page}&per_page=1000`, { headers: headers() });
    if (!res.ok) throw new Error(`listUsers failed: ${res.status}`);
    const { users = [] } = await res.json();
    for (const u of users) if (u.email) map.set(u.email.toLowerCase(), u.id);
    if (users.length < 1000) return map;
  }
};

const createSupabaseUser = async (email, hash) => {
  const body = { email, email_confirm: true };
  if (hash && BCRYPT.test(hash)) body.password_hash = hash;
  const res = await fetch(`${ADMIN}/users`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`createUser ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).id;
};

const main = async () => {
  const select = { id: true, email: true, password: true, supabaseId: true };
  const [users, admins] = await Promise.all([
    prisma.user.findMany({ where: { supabaseId: null }, select }),
    prisma.admin.findMany({ where: { supabaseId: null }, select }),
  ]);

  // Group rows by lowercased email so a user+admin pair maps to one login.
  const byEmail = new Map();
  for (const [table, rows] of [["user", users], ["admin", admins]]) {
    for (const r of rows) {
      if (!r.email) continue;
      const email = r.email.trim().toLowerCase();
      const g = byEmail.get(email) || { rows: [], hash: null };
      g.rows.push({ table, id: r.id });
      // Prefer the user row's hash (that is the password people type in the apps).
      if (!g.hash || table === "user") g.hash = r.password || g.hash;
      byEmail.set(email, g);
    }
  }

  const existing = await loadExisting();
  const stats = { emails: byEmail.size, withPassword: 0, needsReset: 0, googleOnly: 0, alreadyInSupabase: 0, created: 0, linkedRows: 0, failed: 0 };
  for (const g of byEmail.values()) {
    if (!g.hash) stats.googleOnly++;
    else if (BCRYPT.test(g.hash)) stats.withPassword++;
    else stats.needsReset++;
  }

  for (const [email, g] of byEmail) {
    let sid = existing.get(email);
    if (sid) stats.alreadyInSupabase++;
    if (!APPLY) continue;
    try {
      if (!sid) { sid = await createSupabaseUser(email, g.hash); stats.created++; }
      for (const row of g.rows) {
        await prisma[row.table].update({ where: { id: row.id }, data: { supabaseId: sid, password: null } });
        stats.linkedRows++;
      }
    } catch (e) {
      stats.failed++;
      console.error(`FAILED ${g.rows.map((r) => `${r.table}#${r.id}`).join(",")}: ${e.message}`);
    }
  }

  console.log(APPLY ? "IMPORT DONE" : "DRY RUN (nothing written; pass --apply)", stats);
};

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
