const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'winus-video.db');

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// QC editorial incidents (see the 'qc_*' roles below) -- one row per incident
// logged by a QC operator against a live stream, with an optional snapshot
// (JPEG saved to disk by index.js, see INCIDENTS_DIR -- only the relative
// filename is kept here, never the image bytes, so this .db file stays
// small regardless of how many snapshots pile up).
db.exec(`
  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id TEXT NOT NULL,
    stream_name TEXT NOT NULL,
    severity TEXT NOT NULL,
    description TEXT NOT NULL,
    snapshot_path TEXT,
    timecode TEXT,
    operator_username TEXT NOT NULL,
    operator_role TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// QC sessions: a QC operator explicitly "opens a session" on a feed
// (= an existing stream, see the plan -- feeds are not a separate concept)
// before logging incidents against it. One feed can have at most one OPEN
// session at a time (enforced in openSession below), but any number of
// closed/historical sessions.
db.exec(`
  CREATE TABLE IF NOT EXISTS qc_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id TEXT NOT NULL,
    stream_name TEXT NOT NULL,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    opened_by TEXT NOT NULL,
    opened_at TEXT DEFAULT (datetime('now')),
    closed_by TEXT,
    closed_at TEXT
  );
`);

// ── Idempotent column additions (safe to run on every startup) ──
// SQLite has no "ADD COLUMN IF NOT EXISTS", so check PRAGMA table_info first.
// Used to extend the users/incidents tables below without a destructive
// migration -- existing rows just get the default value for new columns.
function ensureColumn(table, column, defSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${defSql}`);
    console.log(`[DB] Added column ${table}.${column}`);
  }
}

// users: active/permanent accounts + forced-password-change (QC Editorial
// user-management features -- see the plan's "Users tab").
ensureColumn('users', 'active', "INTEGER NOT NULL DEFAULT 1");
ensureColumn('users', 'permanent', "INTEGER NOT NULL DEFAULT 1");
ensureColumn('users', 'must_change_password', "INTEGER NOT NULL DEFAULT 0");

// incidents: session link + richer QC Editorial workflow fields. Existing
// rows keep session_id NULL / pending 0 / status 'open' and still show up
// (ungrouped) in reports.
ensureColumn('incidents', 'session_id', 'INTEGER');
ensureColumn('incidents', 'category', 'TEXT');
ensureColumn('incidents', "status", "TEXT NOT NULL DEFAULT 'open'");
ensureColumn('incidents', 'pending', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('incidents', 'void_reason', 'TEXT');
ensureColumn('incidents', 'voided_by', 'TEXT');
ensureColumn('incidents', 'voided_at', 'TEXT');
// P1 on-screen/sound alert acknowledgement (persisted server-side, not just
// in the browser -- see broadcastQcAlert in ws/signaling.js and the
// PUT /api/qc/incidents/:id/ack route).
ensureColumn('incidents', 'p1_acked_by', 'TEXT');
ensureColumn('incidents', 'p1_acked_at', 'TEXT');
// 10s pre/post-roll clip (see services/clip-recorder.js) -- filename only,
// same "never the full path or bytes in the DB" pattern as snapshot_path.
ensureColumn('incidents', 'clip_path', 'TEXT');
// Executive summary + recommendations per session, editable by the
// coordinator/supervisor (see PUT /api/qc/sessions/:id/notes).
ensureColumn('qc_sessions', 'exec_summary', 'TEXT');
ensureColumn('qc_sessions', 'recommendations', 'TEXT');

// Audit log ("quién cambió qué"): QC user management + session deletions --
// the higher-risk administrative actions, not every routine incident edit
// (those already carry their own author/timestamp fields).
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── SuperAdmin reset on startup ──
const SUPERADMIN_USER = 'Winus';
const SUPERADMIN_PASS = 'Winus2026';

(function resetSuperAdmin() {
  const hash = bcrypt.hashSync(SUPERADMIN_PASS, 10);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(SUPERADMIN_USER);
  if (existing) {
    db.prepare('UPDATE users SET password = ?, role = ? WHERE username = ?')
      .run(hash, 'superadmin', SUPERADMIN_USER);
  } else {
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
      .run(SUPERADMIN_USER, hash, 'superadmin');
  }
  console.log('[DB] SuperAdmin "Winus" reset');
})();

// Ensure default admin exists (from .env, for backwards compat)
(function ensureEnvAdmin() {
  const envUser = process.env.ADMIN_USER || 'admin';
  const envPass = process.env.ADMIN_PASS || 'admin';
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(envUser);
  if (!existing) {
    const hash = bcrypt.hashSync(envPass, 10);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
      .run(envUser, hash, 'admin');
    console.log(`[DB] Default admin "${envUser}" created`);
  }
})();

// Migrate the old flat 'qc' role (single-tier incident logging) to the new
// QC Editorial role 'qc_coordinator' -- idempotent, runs on every startup
// but only ever matches rows still on the legacy role name.
(function migrateLegacyQcRole() {
  const info = db.prepare("UPDATE users SET role = 'qc_coordinator' WHERE role = 'qc'").run();
  if (info.changes > 0) console.log(`[DB] Migrated ${info.changes} user(s) from role 'qc' to 'qc_coordinator'`);
})();

const QC_ROLES = ['qc_coordinator', 'qc_supervisor', 'qc_engineer', 'qc_auditor'];

// ── User operations ──

function authenticate(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password)) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    active: !!user.active,
    mustChangePassword: !!user.must_change_password,
  };
}

function getUsers() {
  return db.prepare(
    'SELECT id, username, role, active, permanent, must_change_password, created_at FROM users WHERE username != ? ORDER BY id'
  ).all(SUPERADMIN_USER);
}

// QC Editorial user management is scoped to QC_ROLES only -- this never
// touches/lists viewer/publisher/admin/superadmin accounts, so the existing
// Coms admin-only /api/users endpoints stay completely unaffected.
function getQcUsers() {
  const placeholders = QC_ROLES.map(() => '?').join(',');
  return db.prepare(
    `SELECT id, username, role, active, permanent, must_change_password, created_at
     FROM users WHERE role IN (${placeholders}) ORDER BY id`
  ).all(...QC_ROLES);
}

function getUserById(id) {
  return db.prepare(
    'SELECT id, username, role, active, permanent, must_change_password, created_at FROM users WHERE id = ?'
  ).get(id);
}

function createUser(username, password, role) {
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
    .run(username, hash, role || 'viewer');
  return getUserById(info.lastInsertRowid);
}

// Creates a QC Editorial account with a one-time temporary password (the
// caller, index.js, generates the plaintext and returns it to the requester
// exactly once -- it is never retrievable again, only hashed here).
function createQcUser(username, tempPassword, role, permanent) {
  const hash = bcrypt.hashSync(tempPassword, 10);
  const info = db.prepare(
    `INSERT INTO users (username, password, role, active, permanent, must_change_password)
     VALUES (?, ?, ?, 1, ?, 1)`
  ).run(username, hash, role, permanent ? 1 : 0);
  return getUserById(info.lastInsertRowid);
}

function updateUser(id, { username, password, role }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;
  if (user.username === SUPERADMIN_USER) return null; // protect superadmin

  if (username) db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
  }
  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  return getUserById(id);
}

// Generates+sets a new one-time temporary password for an existing QC
// account (the old password stops working immediately) -- same "show it
// once" contract as createQcUser.
function resetUserPassword(id, tempPassword) {
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
  if (!user || user.username === SUPERADMIN_USER) return null;
  const hash = bcrypt.hashSync(tempPassword, 10);
  db.prepare('UPDATE users SET password = ?, must_change_password = 1 WHERE id = ?').run(hash, id);
  return getUserById(id);
}

// Self-service password change (forced first-login flow): verifies the
// current password, sets the new one, and clears must_change_password.
function changeOwnPassword(username, currentPassword, newPassword) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return { ok: false, error: 'User not found' };
  if (!bcrypt.compareSync(currentPassword, user.password)) return { ok: false, error: 'Current password is incorrect' };
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);
  return { ok: true };
}

function setUserActive(id, active) {
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
  if (!user || user.username === SUPERADMIN_USER) return null;
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return getUserById(id);
}

// Bulk-deactivates every non-permanent QC account except qc_supervisor
// (coordinators' safety net so a mass cleanup can never lock out the
// supervisors who'd need to undo it) -- mirrors the mockup's
// "Disable temporary accounts" action.
function deactivateTempQcUsers() {
  const placeholders = QC_ROLES.map(() => '?').join(',');
  const info = db.prepare(
    `UPDATE users SET active = 0
     WHERE permanent = 0 AND role IN (${placeholders}) AND role != 'qc_supervisor'`
  ).run(...QC_ROLES);
  return info.changes;
}

function deleteUser(id) {
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
  if (!user || user.username === SUPERADMIN_USER) return false;
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return true;
}

// ── QC sessions ──
// A feed (= an existing stream, see the plan) may have at most one OPEN
// session at a time; any number of closed/historical sessions.

function getOpenSessionForStream(streamId) {
  return db.prepare("SELECT * FROM qc_sessions WHERE stream_id = ? AND status = 'open'").get(streamId);
}

function openSession({ streamId, streamName, name, openedBy }) {
  if (getOpenSessionForStream(streamId)) {
    throw new Error('A session is already open on this feed');
  }
  const info = db.prepare(
    `INSERT INTO qc_sessions (stream_id, stream_name, name, status, opened_by)
     VALUES (?, ?, ?, 'open', ?)`
  ).run(streamId, streamName, name || null, openedBy);
  return getSessionById(info.lastInsertRowid);
}

function closeSession(id, closedBy) {
  const session = getSessionById(id);
  if (!session || session.status !== 'open') return null;
  db.prepare(
    "UPDATE qc_sessions SET status = 'closed', closed_by = ?, closed_at = datetime('now') WHERE id = ?"
  ).run(closedBy, id);
  return getSessionById(id);
}

// Closes every currently open session at once ("close the day"). Returns
// the number of sessions that were closed.
function closeAllOpenSessions(closedBy) {
  const info = db.prepare(
    "UPDATE qc_sessions SET status = 'closed', closed_by = ?, closed_at = datetime('now') WHERE status = 'open'"
  ).run(closedBy);
  return info.changes;
}

// incident_count/open_p1_count are correlated subqueries (cheap at this
// scale -- a handful of sessions, each with at most a few hundred
// incidents) so the Monitor grid can show a per-feed incident counter and
// an unresolved-P1 badge (see the spec's "contador y sello P1 por feed")
// without a second round-trip per feed.
function getSessions({ status, streamId } = {}) {
  const clauses = [];
  const params = [];
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (streamId) { clauses.push('stream_id = ?'); params.push(streamId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM incidents i WHERE i.session_id = s.id AND i.void_reason IS NULL) AS incident_count,
      (SELECT COUNT(*) FROM incidents i WHERE i.session_id = s.id AND i.severity = 'P1'
         AND i.status != 'resolved' AND i.void_reason IS NULL) AS open_p1_count
    FROM qc_sessions s ${where} ORDER BY opened_at DESC
  `).all(...params);
}

// Executive summary + recommendations, editable by the coordinator/
// supervisor per session (see the spec's "resumen ejecutivo y
// recomendaciones, editables por el coordinador").
function updateSessionNotes(id, { execSummary, recommendations }) {
  const session = getSessionById(id);
  if (!session) return null;
  db.prepare('UPDATE qc_sessions SET exec_summary = ?, recommendations = ? WHERE id = ?')
    .run(execSummary ?? session.exec_summary ?? null, recommendations ?? session.recommendations ?? null, id);
  return getSessionById(id);
}

function getSessionById(id) {
  return db.prepare('SELECT * FROM qc_sessions WHERE id = ?').get(id);
}

// Deletes a session AND all of its incidents (per the mockup's explicit
// warning: "Delete this session and all its incidents? This cannot be
// undone."). Returns the deleted incidents so the caller (index.js) can
// also unlink their snapshot files, or null if the session didn't exist.
const deleteSessionCascade = db.transaction((id) => {
  const session = getSessionById(id);
  if (!session) return null;
  const incidents = db.prepare('SELECT * FROM incidents WHERE session_id = ?').all(id);
  db.prepare('DELETE FROM incidents WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM qc_sessions WHERE id = ?').run(id);
  return { session, incidents };
});

// ── QC incident operations ──

function createIncident({
  streamId, streamName, severity, description, snapshotPath, timecode,
  operatorUsername, operatorRole, sessionId, category, pending,
}) {
  const info = db.prepare(
    `INSERT INTO incidents
       (stream_id, stream_name, severity, description, snapshot_path, timecode,
        operator_username, operator_role, session_id, category, pending)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    streamId, streamName, severity || 'P3', description || '', snapshotPath || null, timecode || null,
    operatorUsername, operatorRole, sessionId || null, category || null, pending ? 1 : 0
  );
  return getIncidentById(info.lastInsertRowid);
}

// Quick-mark (keyboard shortcut "M" in qc.js): timestamps an incident
// immediately with no description yet (pending=1, "to describe"), to be
// filled in later via describeIncident. snapshotPath is captured AT MARK
// TIME (the exact frame when M was pressed) -- describeIncident's own
// snapshotPath is optional and only overrides this if the operator
// explicitly re-captures a fresher one while describing later.
function markIncidentPending({ streamId, streamName, timecode, sessionId, operatorUsername, operatorRole, snapshotPath }) {
  return createIncident({
    streamId, streamName, timecode, sessionId, operatorUsername, operatorRole, snapshotPath,
    severity: 'P3', description: '', pending: true,
  });
}

function describeIncident(id, { category, severity, description, snapshotPath }) {
  const incident = getIncidentById(id);
  if (!incident) return null;
  db.prepare(
    `UPDATE incidents SET category = ?, severity = ?, description = ?, pending = 0,
       snapshot_path = COALESCE(?, snapshot_path)
     WHERE id = ?`
  ).run(category || null, severity, description, snapshotPath || null, id);
  return getIncidentById(id);
}

const VALID_INCIDENT_STATUSES = new Set(['open', 'in_review', 'notified', 'resolved']);

function setIncidentStatus(id, status) {
  if (!VALID_INCIDENT_STATUSES.has(status)) throw new Error('Invalid status');
  const incident = getIncidentById(id);
  if (!incident) return null;
  db.prepare('UPDATE incidents SET status = ? WHERE id = ?').run(status, id);
  return getIncidentById(id);
}

// Voiding (not deleting) is the normal "this incident doesn't count" path --
// keeps an audit trail (who voided it, when, why). A voided incident can
// later be permanently deleted by a supervisor (see deleteIncident).
function voidIncident(id, { reason, voidedBy }) {
  const incident = getIncidentById(id);
  if (!incident) return null;
  db.prepare(
    "UPDATE incidents SET void_reason = ?, voided_by = ?, voided_at = datetime('now') WHERE id = ?"
  ).run(reason, voidedBy, id);
  return getIncidentById(id);
}

// Persists WHO acknowledged a P1 on-screen/sound alert and WHEN -- the
// server is the source of truth (not just the browser tab that happened to
// click it), so a second coordinator's screen also stops alerting once any
// one of them acknowledges it.
function ackIncident(id, ackedBy) {
  const incident = getIncidentById(id);
  if (!incident) return null;
  db.prepare(
    "UPDATE incidents SET p1_acked_by = ?, p1_acked_at = datetime('now') WHERE id = ?"
  ).run(ackedBy, id);
  return getIncidentById(id);
}

function getIncidents({ sessionId, streamId, status, includeVoided, pending, severity, operatorUsername } = {}) {
  // Newest first -- a coordinator opening the panel wants to see the latest
  // reported issue at the top, not buried under older entries.
  const clauses = [];
  const params = [];
  if (sessionId) { clauses.push('session_id = ?'); params.push(sessionId); }
  if (streamId) { clauses.push('stream_id = ?'); params.push(streamId); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (pending !== undefined) { clauses.push('pending = ?'); params.push(pending ? 1 : 0); }
  if (severity) { clauses.push('severity = ?'); params.push(severity); }
  if (operatorUsername) { clauses.push('operator_username = ?'); params.push(operatorUsername); }
  if (!includeVoided) clauses.push('void_reason IS NULL');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM incidents ${where} ORDER BY id DESC`).all(...params);
}

function getIncidentById(id) {
  return db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
}

// Called once the 10s pre/post-roll clip has been extracted from the
// stream's rolling buffer (see services/clip-recorder.js), a few seconds
// AFTER the incident was marked -- so this is always a follow-up UPDATE,
// never set at insert time.
function setIncidentClip(id, clipPath) {
  const incident = getIncidentById(id);
  if (!incident) return null;
  db.prepare('UPDATE incidents SET clip_path = ? WHERE id = ?').run(clipPath, id);
  return getIncidentById(id);
}

function deleteIncident(id) {
  const incident = getIncidentById(id);
  if (!incident) return null;
  db.prepare('DELETE FROM incidents WHERE id = ?').run(id);
  return incident; // returned so the caller can also unlink its snapshot/clip files
}

// ── Audit log ("quién cambió qué") ──
function logAudit(actor, action, targetType, targetId, details) {
  db.prepare(
    'INSERT INTO audit_log (actor, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)'
  ).run(actor, action, targetType || null, targetId != null ? String(targetId) : null, details || null);
}

function getAuditLog({ limit } = {}) {
  const cap = Math.min(500, Math.max(1, parseInt(limit, 10) || 200));
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(cap);
}

module.exports = {
  authenticate,
  getUsers,
  getQcUsers,
  getUserById,
  createUser,
  createQcUser,
  updateUser,
  resetUserPassword,
  changeOwnPassword,
  setUserActive,
  deactivateTempQcUsers,
  deleteUser,
  SUPERADMIN_USER,
  QC_ROLES,
  createIncident,
  markIncidentPending,
  describeIncident,
  setIncidentStatus,
  voidIncident,
  ackIncident,
  getIncidents,
  getIncidentById,
  deleteIncident,
  openSession,
  closeSession,
  closeAllOpenSessions,
  getSessions,
  getSessionById,
  deleteSessionCascade,
  updateSessionNotes,
  setIncidentClip,
  logAudit,
  getAuditLog,
};
