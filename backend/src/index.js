require('dotenv').config({ path: '/app/.env' });

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const config = require('./config');
const ms = require('./services/mediasoup-manager');
const db = require('./services/database');
const clipRecorder = require('./services/clip-recorder');
const {
  setupSignaling, getStreamGuestLink, regenerateStreamGuestLink,
  getStreamHlsLink, regenerateStreamHlsLink,
  resetSignaling, canManageStream, broadcastQcAlert,
} = require('./ws/signaling');

const JWT_SECRET = process.env.JWT_SECRET || 'winus-video-secret';

// QC Editorial incident snapshots (see the qc_* roles below) -- same
// "shared docker volume" pattern as hls-manager.js's HLS_DIR, so snapshots
// survive container restarts/rebuilds. Only the filename (never the full
// path) is stored in the DB; never served as a static/public path -- always
// through the authenticated GET /api/qc/incidents/:id/snapshot route below.
const INCIDENTS_DIR = process.env.INCIDENTS_DIR || '/app/data/incidents';
fs.mkdirSync(INCIDENTS_DIR, { recursive: true });
const VALID_SEVERITIES = new Set(['P1', 'P2', 'P3']);

// Defense-in-depth: this process serves EVERY active stream/viewer at once, so
// letting one bad, unrelated promise rejection (e.g. a redundant mediasoup
// API call racing a Producer/Consumer that already closed) crash the whole
// process -- as happened with the PGM AudioLevelObserver.removeProducer()
// race, which killed every stream for every viewer over a single departing
// PGM speaker -- is far worse than logging it and staying up. Genuine
// startup failures are still handled by main().catch() below.
process.on('unhandledRejection', (err) => {
  console.error('[FATAL-AVOIDED] Unhandled rejection (ignored to keep the server up):', err);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL-AVOIDED] Uncaught exception (ignored to keep the server up):', err);
});

// ── JWT Middleware ──
function authMiddleware(requiredRoles) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token required' });
    try {
      const decoded = jwt.verify(header.slice(7), JWT_SECRET);
      req.user = decoded;
      if (requiredRoles && !requiredRoles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

async function main() {
  await ms.init();

  const app = express();
  // Default express.json() limit is 100kb -- a QC incident's snapshot
  // (base64 JPEG frame grabbed from the video, see captureSnapshotForDescribe()/
  // submitDescribe() in web/qc.js) routinely exceeds that on its own,
  // which made POST /api/incidents (now /api/qc/incidents/:id/describe)
  // fail with a 413 PayloadTooLargeError BEFORE even reaching the route
  // handler. Express's default error page
  // for that is HTML, not JSON, so the frontend's `res.json()` parse then
  // silently failed too, surfacing only as the generic "Could not log the
  // incident" alert with no indication of the real cause. 5mb comfortably
  // covers a single compressed JPEG frame at any reasonable resolution.
  app.use(express.json({ limit: '5mb' }));

  // ── Public routes ──
  app.get('/health', (req, res) => res.json({ ok: true, viewers: ms.getViewerCount() }));

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.authenticate(username, password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    // QC Editorial accounts can be soft-disabled (see db.setUserActive) --
    // Coms viewer/publisher/admin accounts always have active=1 so this is
    // a no-op for them.
    if (!user.active) return res.status(403).json({ error: 'Account disabled. Talk to the supervisor.' });
    const token = jwt.sign(
      { user: user.username, role: user.role, userId: user.id },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token, role: user.role, mustChangePassword: user.mustChangePassword });
  });

  // ── Protected routes ──
  // These were labeled "protected" but had NO middleware at all -- anyone,
  // authenticated or not, could hit them. authMiddleware() with no roles
  // array just requires a valid token (any role), which is all these ever
  // needed since no viewer-facing code actually calls them (streams/PGM
  // state comes over the WS 'streams' push instead).
  const anyAuth = authMiddleware();
  app.get('/api/stats', anyAuth, (req, res) => res.json(ms.getStats()));
  app.get('/api/streams', anyAuth, (req, res) => res.json(ms.getActiveStreams()));
  app.get('/api/router-rtp-capabilities', anyAuth, (req, res) => res.json(ms.getRouterRtpCapabilities()));

  // ── User CRUD (admin/superadmin only) ──
  const adminAuth = authMiddleware(['admin', 'superadmin']);
  // Guest-link generation/regeneration: admin/superadmin AND publisher --
  // a publisher needs to be able to hand a commentator their link for a
  // stream they operate, without needing full admin access (which stays
  // gated behind adminAuth everywhere else: user CRUD, Reset Server,
  // disconnect-guest, PGM volume/private-talk, force-stop-stream).
  const linkAuth = authMiddleware(['admin', 'superadmin', 'publisher']);

  // Passwordless guest link for a single stream (e.g. to send to a
  // commentator). The key is generated once, the first time that stream
  // ever publishes video, and never rotates afterwards (see streamGuestKeys
  // in ws/signaling.js) -- so the SAME url keeps working across reconnects
  // and future re-broadcasts of that stream, regardless of who's operating
  // the publisher. It only 404s if that stream has never published at all
  // yet (no key exists to hand out).
  // Prefer EXTERNAL_IP/HTTPS_PORT from .env (the same values deploy.sh
  // prints for "Web viewer:" / used to generate the TLS cert) over the Host
  // header forwarded by nginx: a misconfigured proxy_set_header there (e.g.
  // nginx's $host, which silently drops the port) would otherwise produce a
  // broken link with no obvious error anywhere. Always https: the
  // public-facing side (nginx) only ever serves https.
  function buildGuestLinkUrl(req, streamId, key) {
    const externalIp = process.env.EXTERNAL_IP;
    const httpsPort = process.env.HTTPS_PORT || '9443';
    const host = externalIp
      ? (httpsPort === '443' ? externalIp : `${externalIp}:${httpsPort}`)
      : req.get('host');
    return `https://${host}/?s=${encodeURIComponent(streamId)}&k=${encodeURIComponent(key)}`;
  }

  // A 'publisher' account ("streamer") may only generate/regenerate the
  // link for a stream it is CURRENTLY the live owner of (see
  // canManageStream in ws/signaling.js, backed by channelOwners) -- it can
  // see every stream via GET /api/streams (anyAuth above, unrestricted), but
  // must never be able to hand out or rotate someone ELSE's guest link.
  // admin/superadmin are exempt and can manage any stream.
  function requireStreamOwnership(req, res, next) {
    if (req.user.role !== 'publisher' || canManageStream(req.params.streamId, req.user.role, req.user.user)) {
      return next();
    }
    res.status(403).json({ error: 'Solo pod\u00e9s generar el link de tus propios streams' });
  }

  app.get('/api/streams/:streamId/link', linkAuth, requireStreamOwnership, (req, res) => {
    const key = getStreamGuestLink(req.params.streamId);
    if (!key) return res.status(404).json({ error: 'Stream has never published yet' });
    res.json({ url: buildGuestLinkUrl(req, req.params.streamId, key) });
  });

  // Admin "New Link": rotates the guest key so the OLD link stops working for
  // any future connection attempt (see regenerateStreamGuestLink's docs).
  // Does not affect already-connected guests -- pair with the WS
  // 'disconnectGuest' action to also kick them right now if needed.
  app.post('/api/streams/:streamId/link/regenerate', linkAuth, requireStreamOwnership, (req, res) => {
    const key = regenerateStreamGuestLink(req.params.streamId);
    res.json({ url: buildGuestLinkUrl(req, req.params.streamId, key) });
  });

  // HLS link: same unguessable-key model as the guest link above, but a
  // DELIBERATELY BROADER audience is allowed to generate/copy it --
  // admin/superadmin/publisher (with the same per-stream ownership
  // restriction for 'publisher') PLUS plain 'viewer' accounts, which
  // otherwise have no admin-ish capability anywhere else in this app. This
  // is the one thing a 'viewer' account may do beyond just watching. It does
  // NOT let a viewer turn HLS on/off -- that stays a publisher-only action
  // (see the WS 'setHlsEnabled' case), the link just won't resolve (404 at
  // nginx) until the publisher's own "HLS" checkbox is on. Points DIRECTLY
  // at the raw nginx-served .m3u8 (no web/hls.html wrapper/overlay) -- a TV
  // that can't do WebRTC gets exactly the HLS stream, no clock/name overlay.
  const hlsLinkAuth = authMiddleware(['admin', 'superadmin', 'publisher', 'viewer']);
  function buildHlsLinkUrl(req, streamId, key) {
    const externalIp = process.env.EXTERNAL_IP;
    const httpsPort = process.env.HTTPS_PORT || '9443';
    const host = externalIp
      ? (httpsPort === '443' ? externalIp : `${externalIp}:${httpsPort}`)
      : req.get('host');
    return `https://${host}/hls/${encodeURIComponent(key)}/playlist.m3u8`;
  }

  app.get('/api/streams/:streamId/hls-link', hlsLinkAuth, requireStreamOwnership, (req, res) => {
    const key = getStreamHlsLink(req.params.streamId);
    if (!key) return res.status(404).json({ error: 'Stream has never published yet' });
    res.json({ url: buildHlsLinkUrl(req, req.params.streamId, key) });
  });

  app.post('/api/streams/:streamId/hls-link/regenerate', hlsLinkAuth, requireStreamOwnership, (req, res) => {
    const key = regenerateStreamHlsLink(req.params.streamId);
    res.json({ url: buildHlsLinkUrl(req, req.params.streamId, key) });
  });

  // Deliberately PUBLIC (no JWT): the only endpoint web/hls.html itself
  // needs, since a TV's browser can't practically hold a login session --
  // its security is the same unguessable-key model as everything else here.
  // Validates the key, confirms the stream is currently live AND has HLS
  // actually enabled right now (the link can exist long before/after that),
  // and hands back just enough for the player page to work: the human
  // stream name (for the overlay) and the nginx-served playlist URL.
  app.get('/api/hls-info', (req, res) => {
    const { s: streamId, k: key } = req.query;
    if (!streamId || !key) return res.status(400).json({ error: 'streamId and key required' });
    const expected = getStreamHlsLink(streamId);
    if (!expected || expected !== key) return res.status(404).json({ error: 'Invalid link' });
    const stream = ms.getActiveStreams().find((s) => s.streamId === streamId);
    if (!stream || !stream.hlsEnabled) return res.status(404).json({ error: 'HLS not currently live for this stream' });
    res.json({
      streamName: stream.streamName || streamId,
      playlistUrl: `/hls/${encodeURIComponent(key)}/playlist.m3u8`,
    });
  });

  app.get('/api/users', adminAuth, (req, res) => {
    res.json(db.getUsers());
  });

  app.post('/api/users', adminAuth, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    // QC Editorial accounts (qc_coordinator/qc_supervisor/qc_engineer/
    // qc_auditor) are managed exclusively through /api/qc/users below
    // (temp-password + forced-change flow) -- never through this plain
    // Coms user CRUD endpoint.
    if (!['viewer', 'publisher', 'admin'].includes(role || 'viewer')) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    try {
      const user = db.createUser(username, password, role || 'viewer');
      res.status(201).json(user);
    } catch (err) {
      res.status(409).json({ error: 'Username already exists' });
    }
  });

  app.put('/api/users/:id', adminAuth, (req, res) => {
    const user = db.updateUser(parseInt(req.params.id), req.body);
    if (!user) return res.status(404).json({ error: 'User not found or protected' });
    res.json(user);
  });

  app.delete('/api/users/:id', adminAuth, (req, res) => {
    const ok = db.deleteUser(parseInt(req.params.id));
    if (!ok) return res.status(404).json({ error: 'User not found or protected' });
    res.json({ ok: true });
  });

  // ── QC Editorial: sessions + incidents + reports + QC user management ──
  // Four QC roles (see database.js's QC_ROLES): qc_coordinator/qc_engineer
  // can open/close their own sessions and mark/describe/void their own
  // incidents; qc_supervisor gets all of that plus QC user management,
  // close-the-day, and deleting sessions/permanently deleting voided
  // incidents; qc_auditor is read-only. admin/superadmin keep full access
  // (same "coordinator oversight" the old flat 'qc' role had).
  const qcAny = authMiddleware(['qc_coordinator', 'qc_supervisor', 'qc_engineer', 'qc_auditor', 'admin', 'superadmin']);
  const qcWrite = authMiddleware(['qc_coordinator', 'qc_supervisor', 'qc_engineer', 'admin', 'superadmin']);
  const qcSupervisorAuth = authMiddleware(['qc_supervisor', 'admin', 'superadmin']);
  function isQcSupervisor(role) { return ['qc_supervisor', 'admin', 'superadmin'].includes(role); }

  // Decodes a `data:image/jpeg;base64,...` (or bare base64) snapshot to a
  // JPEG file on disk and returns just its filename (never the full path or
  // the image bytes) for storage in the incidents table.
  function saveSnapshot(dataUrl) {
    if (!dataUrl) return null;
    const match = /^data:image\/\w+;base64,(.+)$/.exec(dataUrl);
    const buffer = Buffer.from(match ? match[1] : dataUrl, 'base64');
    const filename = `incident-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
    fs.writeFileSync(path.join(INCIDENTS_DIR, filename), buffer);
    return filename;
  }

  // A non-supervisor QC operator may only describe/void/delete-draft THEIR
  // OWN incidents (fat-finger corrections) -- supervisors/admins can act on
  // any incident (coordinator oversight), same shape as the old
  // requireStreamOwnership for publishers.
  function requireQcIncidentOwnership(req, res, next) {
    const incident = db.getIncidentById(parseInt(req.params.id));
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    if (isQcSupervisor(req.user.role) || incident.operator_username === req.user.user) {
      req.incident = incident;
      return next();
    }
    res.status(403).json({ error: 'You can only act on your own incidents' });
  }

  // ── Sessions ──
  app.post('/api/qc/sessions', qcWrite, (req, res) => {
    const { streamId, streamName, name } = req.body;
    if (!streamId) return res.status(400).json({ error: 'streamId required' });
    try {
      const session = db.openSession({ streamId, streamName: streamName || streamId, name, openedBy: req.user.user });
      // An open QC session is what "actively monitoring this feed" means --
      // start the rolling incident-clip buffer (see clip-recorder.js) for its
      // stream now, so a 10s clip is already available the moment an
      // operator marks an incident, instead of only starting to buffer AFTER
      // the first mark (which would miss the pre-roll entirely).
      ms.setClipRecordingEnabled(streamId, true).catch((err) =>
        console.error(`[QC] Failed to start clip recording for ${streamId}:`, err));
      res.status(201).json(session);
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  app.get('/api/qc/sessions', qcAny, (req, res) => {
    res.json(db.getSessions({ status: req.query.status, streamId: req.query.streamId }));
  });

  app.post('/api/qc/sessions/:id/close', qcWrite, (req, res) => {
    const session = db.closeSession(parseInt(req.params.id), req.user.user);
    if (!session) return res.status(404).json({ error: 'Session not found or not open' });
    // Stop the clip buffer for this feed -- only one session can be open per
    // stream at a time (see db.openSession), so closing this one always
    // means nobody is actively monitoring that stream anymore right now.
    ms.setClipRecordingEnabled(session.stream_id, false).catch((err) =>
      console.error(`[QC] Failed to stop clip recording for ${session.stream_id}:`, err));
    res.json(session);
  });

  // "Close the day": closes every currently open session at once.
  app.post('/api/qc/sessions/close-day', qcSupervisorAuth, (req, res) => {
    const openStreamIds = db.getSessions({ status: 'open' }).map((s) => s.stream_id);
    const closed = db.closeAllOpenSessions(req.user.user);
    for (const streamId of openStreamIds) {
      ms.setClipRecordingEnabled(streamId, false).catch((err) =>
        console.error(`[QC] Failed to stop clip recording for ${streamId}:`, err));
    }
    res.json({ ok: true, closed });
  });

  // Executive summary + recommendations, editable by the coordinator/
  // supervisor (see the spec's "resumen ejecutivo y recomendaciones").
  app.put('/api/qc/sessions/:id/notes', qcWrite, (req, res) => {
    const { execSummary, recommendations } = req.body;
    const session = db.updateSessionNotes(parseInt(req.params.id), { execSummary, recommendations });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  // Deletes a session AND all of its incidents (the client is expected to
  // show the mockup's own warning -- "did you already export the report?"
  // -- before calling this).
  app.delete('/api/qc/sessions/:id', qcSupervisorAuth, (req, res) => {
    const result = db.deleteSessionCascade(parseInt(req.params.id));
    if (!result) return res.status(404).json({ error: 'Session not found' });
    for (const inc of result.incidents) {
      if (inc.snapshot_path) { try { fs.unlinkSync(path.join(INCIDENTS_DIR, inc.snapshot_path)); } catch (_) {} }
      if (inc.clip_path) { try { fs.unlinkSync(clipRecorder.clipOutputPath(inc.clip_path)); } catch (_) {} }
    }
    if (result.session.status === 'open') {
      ms.setClipRecordingEnabled(result.session.stream_id, false).catch((err) =>
        console.error(`[QC] Failed to stop clip recording for ${result.session.stream_id}:`, err));
    }
    db.logAudit(req.user.user, 'qc_session_delete', 'session', result.session.id,
      `stream=${result.session.stream_id} incidents=${result.incidents.length}`);
    res.json({ ok: true });
  });

  // ── Incidents ──
  // Quick-mark (keyboard shortcut "M" in qc.js): timestamps an incident
  // instantly with no description yet. `snapshot` is captured by the client
  // at the EXACT moment of marking (the active feed's current frame) so the
  // right frame is preserved even if the description is filled in much
  // later -- describeIncident's own snapshot only overrides this if the
  // operator explicitly re-captures a fresher one.
  // Scheduling delay for extractClip() below: must run AFTER the post-roll
  // window has actually landed on disk as finalized segment files (see
  // clip-recorder.js's POST_ROLL_MS/SEGMENT_SLACK_MS docs), plus a small
  // fixed margin for the gst-launch/ffmpeg pipeline's own latency.
  const CLIP_EXTRACTION_DELAY_MS = clipRecorder.POST_ROLL_MS + clipRecorder.SEGMENT_SLACK_MS + 1000;

  app.post('/api/qc/incidents/mark', qcWrite, (req, res) => {
    const { streamId, streamName, timecode, sessionId, snapshot } = req.body;
    if (!streamId) return res.status(400).json({ error: 'streamId required' });
    const markTimeMs = Date.now();
    let snapshotPath = null;
    if (snapshot) {
      try { snapshotPath = saveSnapshot(snapshot); } catch (err) { console.error('[QC] Failed to save mark-time snapshot:', err); }
    }
    try {
      const incident = db.markIncidentPending({
        streamId, streamName: streamName || streamId, timecode, snapshotPath,
        sessionId: sessionId || null, operatorUsername: req.user.user, operatorRole: req.user.role,
      });
      // Extract the 10s (5s pre/post-roll) clip from the rolling buffer (see
      // clip-recorder.js) once the post-roll window has had time to land on
      // disk. Fire-and-forget: the incident is already saved/returned to the
      // operator either way -- the clip just attaches to it a few seconds
      // later (see GET .../clip below, which 404s gracefully until then).
      setTimeout(() => {
        clipRecorder.extractClip(streamId, markTimeMs, `incident-${incident.id}`)
          .then((filename) => { if (filename) db.setIncidentClip(incident.id, filename); })
          .catch((err) => console.error(`[QC] Clip extraction failed for incident ${incident.id}:`, err));
      }, CLIP_EXTRACTION_DELAY_MS);
      res.status(201).json(incident);
    } catch (err) {
      console.error('[QC] Failed to mark incident:', err);
      res.status(500).json({ error: 'Failed to mark incident' });
    }
  });

  // Fills in a pending/quick-marked incident (or edits a described one).
  // Broadcasts a live P1 alert (see broadcastQcAlert in ws/signaling.js) the
  // instant a VALID (not voided -- void only happens after this point
  // anyway) incident is saved with severity P1, so coordinator/supervisor
  // screens currently connected can flash/sound an alert. Only fires for
  // this live save, never for historical data -- a client that connects
  // later never retroactively alerts on pre-existing P1s.
  app.put('/api/qc/incidents/:id/describe', qcWrite, requireQcIncidentOwnership, (req, res) => {
    const { category, severity, description, snapshot } = req.body;
    if (!description) return res.status(400).json({ error: 'description required' });
    if (!VALID_SEVERITIES.has(severity)) return res.status(400).json({ error: 'severity must be P1, P2 or P3' });
    let snapshotPath = null;
    if (snapshot) {
      try { snapshotPath = saveSnapshot(snapshot); } catch (err) { console.error('[QC] Failed to save snapshot:', err); }
    }
    const incident = db.describeIncident(req.incident.id, { category, severity, description, snapshotPath });
    if (incident && incident.severity === 'P1' && !incident.void_reason) {
      broadcastQcAlert({
        id: incident.id, streamName: incident.stream_name, category: incident.category,
        description: incident.description, timecode: incident.timecode, createdAt: incident.created_at,
      });
    }
    res.json(incident);
  });

  // Acknowledges a P1 on-screen/sound alert (see broadcastQcAlert) -- the
  // supervisor/coordinator wording in the spec limits WHO gets alerted to
  // those two roles (plus admin/superadmin), so ack is scoped the same way.
  const qcAlertAuth = authMiddleware(['qc_coordinator', 'qc_supervisor', 'admin', 'superadmin']);
  app.put('/api/qc/incidents/:id/ack', qcAlertAuth, (req, res) => {
    const incident = db.ackIncident(parseInt(req.params.id), req.user.user);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    res.json(incident);
  });

  app.put('/api/qc/incidents/:id/status', qcWrite, (req, res) => {
    try {
      const incident = db.setIncidentStatus(parseInt(req.params.id), req.body.status);
      if (!incident) return res.status(404).json({ error: 'Incident not found' });
      res.json(incident);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Void (not delete): keeps an audit trail of who voided it, when, why.
  app.put('/api/qc/incidents/:id/void', qcWrite, requireQcIncidentOwnership, (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });
    res.json(db.voidIncident(req.incident.id, { reason, voidedBy: req.user.user }));
  });

  app.get('/api/qc/incidents', qcAny, (req, res) => {
    const { sessionId, streamId, status, includeVoided, pending, severity, operatorUsername } = req.query;
    res.json(db.getIncidents({
      sessionId: sessionId ? parseInt(sessionId) : undefined,
      streamId, status, includeVoided: includeVoided === '1' || includeVoided === 'true',
      pending: pending === undefined ? undefined : (pending === '1' || pending === 'true'),
      severity: severity || undefined, operatorUsername: operatorUsername || undefined,
    }));
  });

  app.get('/api/qc/incidents/:id/snapshot', qcAny, (req, res) => {
    const incident = db.getIncidentById(parseInt(req.params.id));
    if (!incident || !incident.snapshot_path) return res.status(404).json({ error: 'No snapshot for this incident' });
    res.sendFile(path.join(INCIDENTS_DIR, incident.snapshot_path), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Snapshot file missing' });
    });
  });

  // 10s (5s pre/post-roll) incident clip (see clip-recorder.js). May 404
  // for a short while right after marking -- extraction only completes a
  // few seconds later (see CLIP_EXTRACTION_DELAY_MS above) -- or
  // permanently if the feed's rolling buffer didn't have enough overlap
  // (e.g. recording had just (re)started).
  app.get('/api/qc/incidents/:id/clip', qcAny, (req, res) => {
    const incident = db.getIncidentById(parseInt(req.params.id));
    if (!incident || !incident.clip_path) return res.status(404).json({ error: 'No clip for this incident' });
    res.sendFile(clipRecorder.clipOutputPath(incident.clip_path), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Clip file missing' });
    });
  });

  // A pending (undescribed) draft can be deleted outright by its own author
  // or a supervisor. An already-voided incident may only be PERMANENTLY
  // deleted by a supervisor (coordinators/engineers can void, but not purge).
  app.delete('/api/qc/incidents/:id', qcWrite, requireQcIncidentOwnership, (req, res) => {
    const incident = req.incident;
    const isVoided = !!incident.void_reason;
    if (!incident.pending && !isVoided) {
      return res.status(403).json({ error: 'Only pending drafts or voided incidents can be deleted' });
    }
    if (isVoided && !isQcSupervisor(req.user.role)) {
      return res.status(403).json({ error: 'Only a supervisor can permanently delete a voided incident' });
    }
    const deleted = db.deleteIncident(incident.id);
    if (deleted?.snapshot_path) {
      try { fs.unlinkSync(path.join(INCIDENTS_DIR, deleted.snapshot_path)); } catch (_) {}
    }
    if (deleted?.clip_path) {
      try { fs.unlinkSync(clipRecorder.clipOutputPath(deleted.clip_path)); } catch (_) {}
    }
    res.json({ ok: true });
  });

  // ── Reports (session + consolidated day) ──
  function summarizeIncidents(incidents) {
    const active = incidents.filter((i) => !i.void_reason);
    const bySeverity = { P1: 0, P2: 0, P3: 0 };
    const byCategory = {};
    for (const i of active) {
      if (bySeverity[i.severity] !== undefined) bySeverity[i.severity]++;
      if (i.category) byCategory[i.category] = (byCategory[i.category] || 0) + 1;
    }
    return { total: active.length, voided: incidents.length - active.length, bySeverity, byCategory };
  }

  function buildIncidentsCsv(rows) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let csv = 'ID,Feed,Session,Category,Severity,Status,Description,Timecode,Operator,Role,Voided,Date\n';
    for (const inc of rows) {
      csv += [
        esc(inc.id), esc(inc.stream_name), esc(inc.session_id), esc(inc.category), esc(inc.severity),
        esc(inc.status), esc(inc.description), esc(inc.timecode), esc(inc.operator_username),
        esc(inc.operator_role), esc(inc.void_reason ? 'yes' : 'no'), esc(inc.created_at),
      ].join(',') + '\n';
    }
    return csv;
  }

  // Reports deliberately EXCLUDE voided incidents (includeVoided defaults
  // to false in db.getIncidents) AND pending/undescribed drafts (pending:
  // false) -- a report is meant to reflect validated, real incidents only.
  app.get('/api/qc/reports/session/:id', qcAny, (req, res) => {
    const session = db.getSessionById(parseInt(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const incidents = db.getIncidents({ sessionId: session.id, pending: false });
    res.json({ session, incidents, summary: summarizeIncidents(incidents) });
  });

  app.get('/api/qc/reports/session/:id/export.csv', qcAny, (req, res) => {
    const session = db.getSessionById(parseInt(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const incidents = db.getIncidents({ sessionId: session.id, pending: false });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="qc_session_${session.id}.csv"`);
    res.send(buildIncidentsCsv(incidents));
  });

  // Consolidated day report: every session opened or closed on the given
  // date (default: today), with all of their incidents.
  function sessionsForDay(date) {
    return db.getSessions().filter((s) => (s.opened_at || '').startsWith(date) || (s.closed_at || '').startsWith(date));
  }

  app.get('/api/qc/reports/day', qcAny, (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const sessions = sessionsForDay(date);
    const incidents = sessions.flatMap((s) => db.getIncidents({ sessionId: s.id, pending: false }));
    res.json({ date, sessions, incidents, summary: summarizeIncidents(incidents) });
  });

  app.get('/api/qc/reports/day/export.csv', qcAny, (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const sessions = sessionsForDay(date);
    const incidents = sessions.flatMap((s) => db.getIncidents({ sessionId: s.id, pending: false }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="qc_day_${date}.csv"`);
    res.send(buildIncidentsCsv(incidents));
  });

  // ── QC user management (scoped to QC_ROLES only via db.getQcUsers --
  // never touches/lists viewer/publisher/admin/superadmin accounts, so the
  // existing Coms /api/users endpoints above stay completely unaffected) ──
  function generateTempPassword() {
    // 10+ chars, letters AND numbers -- matches the mockup's own password
    // rule (see errPwRules) and the /api/change-password validation below.
    return crypto.randomBytes(6).toString('hex') + Math.floor(1000 + Math.random() * 9000);
  }

  app.get('/api/qc/users', qcSupervisorAuth, (req, res) => {
    res.json(db.getQcUsers());
  });

  app.post('/api/qc/users', qcSupervisorAuth, (req, res) => {
    const { username, role, permanent } = req.body;
    if (!username || !db.QC_ROLES.includes(role)) {
      return res.status(400).json({ error: 'username and a valid QC role are required' });
    }
    const tempPassword = generateTempPassword();
    try {
      const user = db.createQcUser(username, tempPassword, role, permanent !== false);
      db.logAudit(req.user.user, 'qc_user_create', 'user', user.id, `username=${username} role=${role}`);
      res.status(201).json({ ...user, tempPassword });
    } catch (err) {
      res.status(409).json({ error: 'Username already exists' });
    }
  });

  app.put('/api/qc/users/:id', qcSupervisorAuth, (req, res) => {
    const { role } = req.body;
    if (role && !db.QC_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid QC role' });
    const user = db.updateUser(parseInt(req.params.id), { role });
    if (!user) return res.status(404).json({ error: 'User not found or protected' });
    if (role) db.logAudit(req.user.user, 'qc_user_role_change', 'user', user.id, `role=${role}`);
    res.json(user);
  });

  app.post('/api/qc/users/:id/reset-password', qcSupervisorAuth, (req, res) => {
    const tempPassword = generateTempPassword();
    const user = db.resetUserPassword(parseInt(req.params.id), tempPassword);
    if (!user) return res.status(404).json({ error: 'User not found or protected' });
    db.logAudit(req.user.user, 'qc_user_reset_password', 'user', user.id, `username=${user.username}`);
    res.json({ ...user, tempPassword });
  });

  app.post('/api/qc/users/:id/activate', qcSupervisorAuth, (req, res) => {
    const user = db.setUserActive(parseInt(req.params.id), true);
    if (!user) return res.status(404).json({ error: 'User not found or protected' });
    db.logAudit(req.user.user, 'qc_user_activate', 'user', user.id, `username=${user.username}`);
    res.json(user);
  });

  app.post('/api/qc/users/:id/deactivate', qcSupervisorAuth, (req, res) => {
    const user = db.setUserActive(parseInt(req.params.id), false);
    if (!user) return res.status(404).json({ error: 'User not found or protected' });
    db.logAudit(req.user.user, 'qc_user_deactivate', 'user', user.id, `username=${user.username}`);
    res.json(user);
  });

  // Bulk-deactivates every non-permanent QC account except qc_supervisor.
  app.post('/api/qc/users/deactivate-temp', qcSupervisorAuth, (req, res) => {
    const deactivated = db.deactivateTempQcUsers();
    db.logAudit(req.user.user, 'qc_user_deactivate_temp', null, null, `deactivated=${deactivated}`);
    res.json({ ok: true, deactivated });
  });

  app.delete('/api/qc/users/:id', qcSupervisorAuth, (req, res) => {
    const id = parseInt(req.params.id);
    const target = db.getUserById(id);
    const ok = db.deleteUser(id);
    if (!ok) return res.status(404).json({ error: 'User not found or protected' });
    db.logAudit(req.user.user, 'qc_user_delete', 'user', id, target ? `username=${target.username}` : undefined);
    res.json({ ok: true });
  });

  // Read-only audit trail of QC user management + session deletion actions
  // (see db.logAudit's call sites above) -- supervisor+ only, same as QC
  // user management itself.
  app.get('/api/qc/audit-log', qcSupervisorAuth, (req, res) => {
    res.json(db.getAuditLog({ limit: req.query.limit }));
  });

  // Self-service password change (any authenticated role) -- satisfies the
  // forced first-login change for QC temp passwords.
  app.post('/api/change-password', anyAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 10 || !/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({ error: 'At least 10 characters, with letters and numbers' });
    }
    const result = db.changeOwnPassword(req.user.user, currentPassword, newPassword);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  });

  // Reset endpoint (admin/superadmin only)
  app.post('/api/reset', adminAuth, (req, res) => {
    ms.resetAll();
    // BUGFIX: ms.resetAll() only knows about mediasoup-level resources -- it
    // never cleared signaling.js's own channelOwners "who owns which
    // stream" locks, which left every previously-live stream permanently
    // locked to its now-gone peerId ("Channel X locked by Y" forever, no way
    // to republish without restarting the whole backend process). See
    // resetSignaling's docs in ws/signaling.js.
    resetSignaling();
    res.json({ ok: true, message: 'All streams and connections reset' });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupSignaling(wss, JWT_SECRET);

  server.listen(config.port, () => {
    console.log(`Winus Video Server running on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
