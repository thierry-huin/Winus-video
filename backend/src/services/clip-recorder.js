/**
 * Incident Clip Recorder (Frigate-inspired rolling buffer)
 *
 * For every QC session that has an operator actively monitoring a feed, we
 * keep a short rolling buffer of that stream's video+audio on disk as small
 * MPEG-TS segments (like Frigate's per-camera segment recorder). When the
 * operator marks an incident (see index.js's POST /api/qc/incidents/mark),
 * we don't need to do anything special in real time -- the buffer is
 * ALREADY there. A few seconds later (once the post-roll segments have
 * landed on disk), extractClip() picks every buffered segment that overlaps
 * [markTime-5s, markTime+5s] and concatenates them losslessly (stream copy,
 * no re-encode) into a single playable .mp4 for that incident.
 *
 * This deliberately mirrors hls-manager.js's architecture (same PlainTransport
 * + mediasoup Consumer + gst-launch-1.0 approach, so it costs no extra
 * decode/encode beyond the existing HLS passthrough), but writes small
 * fixed-size .ts segments via splitmuxsink instead of an HLS playlist.
 *
 * Segment boundaries are NOT frame-accurate against the mark timestamp --
 * splitmuxsink (like hlssink2) can only cut on a keyframe boundary, so a
 * segment's actual duration tracks the publisher's keyframe interval, not
 * exactly SEGMENT_SECONDS. Segments are selected by filesystem mtime (set
 * when GStreamer closes/finalizes that segment file), which is treated as
 * the segment's END time. That's precise enough for a QC review clip (a
 * couple of extra seconds of padding on either end is harmless) without
 * needing to parse GStreamer bus messages for exact per-fragment timestamps.
 */

const { spawn, execFile } = require('child_process');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLIP_BUFFER_DIR = process.env.CLIP_BUFFER_DIR || '/app/data/clip-buffer';
const CLIP_OUTPUT_DIR = process.env.CLIP_OUTPUT_DIR || '/app/data/clips';

// Segments are cut roughly every SEGMENT_SECONDS (subject to keyframe
// alignment, see module comment above). MAX_SEGMENT_FILES * SEGMENT_SECONDS
// is the rolling buffer's total depth -- 20 x 2s = 40s, comfortably more
// than the 5s pre-roll we need even accounting for keyframe-interval slop
// and the delay between a mark and extractClip() actually running.
const SEGMENT_SECONDS = 2;
const MAX_SEGMENT_FILES = 20;
// Pre/post-roll requested around the mark instant.
const PRE_ROLL_MS = 5000;
const POST_ROLL_MS = 5000;
// Extra slack added to the post-roll edge of the segment-selection window to
// account for a segment's mtime being its END (not start) time -- a segment
// ending at T can contain content starting up to ~SEGMENT_SECONDS earlier,
// and splitmuxsink's actual cut can run a bit past the nominal duration.
const SEGMENT_SLACK_MS = SEGMENT_SECONDS * 1500;

// streamId -> { process, videoTransport, audioTransport, videoConsumer, audioConsumer, dir }
const sessions = new Map();

// Same "bind to port 0, read it, close it" trick as hls-manager.js's
// reserveUdpPort() -- picks a free local UDP port for gst-launch's udpsrc.
function reserveUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

// Same caps-building helper as hls-manager.js's rtpCapsFor() -- duplicated
// rather than imported so this module stays self-contained/independently
// testable, same as hls-manager.js itself.
function rtpCapsFor(kind, rtpParameters) {
  const codec = rtpParameters.codecs[0];
  const encodingName = codec.mimeType.split('/')[1].toUpperCase();
  return `application/x-rtp,media=${kind},encoding-name=${encodingName},` +
    `payload=${codec.payloadType},clock-rate=${codec.clockRate}`;
}

function bufferDirFor(streamId) {
  return path.join(CLIP_BUFFER_DIR, streamId);
}

/**
 * Start (or restart, if already running) the rolling clip buffer for
 * `streamId`. Same signature/semantics as hls-manager.js's startHls().
 */
async function startClipRecording(streamId, router, videoProducer, audioProducer) {
  await stopClipRecording(streamId); // idempotent: replace any previous session cleanly

  if (!videoProducer || videoProducer.closed) {
    throw new Error(`No video producer to record clips from for stream=${streamId}`);
  }

  // Same HEVC safety net as hls-manager.js: this pipeline's video branch is
  // a fixed H.264 passthrough (rtph264depay/h264parse below).
  const videoMime = (videoProducer.rtpParameters?.codecs?.[0]?.mimeType || '').toLowerCase();
  if (videoMime === 'video/h265' || videoMime === 'video/hevc') {
    console.log(`[ClipRecorder] ${streamId}: skipped -- HEVC (H.265) video is not supported by this pipeline (H.264-only passthrough)`);
    return;
  }

  const dir = bufferDirFor(streamId);
  // Wipe any stale segments from a previous recording session: a Producer
  // can change codec/format across a stop+republish, and mixing old/new
  // segments in the SAME rolling buffer would break ffmpeg's lossless
  // concat later.
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(dir, { recursive: true });

  const videoPort = await reserveUdpPort();
  const audioPort = (audioProducer && !audioProducer.closed) ? await reserveUdpPort() : null;

  const videoTransport = await router.createPlainTransport({
    listenInfo: { protocol: 'udp', ip: '0.0.0.0', announcedAddress: '127.0.0.1' },
    rtcpMux: true,
    comedia: false,
  });
  await videoTransport.connect({ ip: '127.0.0.1', port: videoPort });
  const videoConsumer = await videoTransport.consume({
    producerId: videoProducer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: true,
  });

  let audioTransport = null, audioConsumer = null;
  if (audioPort) {
    audioTransport = await router.createPlainTransport({
      listenInfo: { protocol: 'udp', ip: '0.0.0.0', announcedAddress: '127.0.0.1' },
      rtcpMux: true,
      comedia: false,
    });
    await audioTransport.connect({ ip: '127.0.0.1', port: audioPort });
    audioConsumer = await audioTransport.consume({
      producerId: audioProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
    });
  }

  const gstArgs = [
    '-e', '-v',
    'splitmuxsink', 'name=splitmux',
    `location=${path.join(dir, 'segment%05d.ts')}`,
    'muxer-factory=mpegtsmux',
    `max-size-time=${SEGMENT_SECONDS * 1000000000}`, // nanoseconds
    `max-files=${MAX_SEGMENT_FILES}`,
    'udpsrc', `port=${videoPort}`, `caps=${rtpCapsFor('video', videoConsumer.rtpParameters)}`,
    '!', 'rtpjitterbuffer', '!', 'rtph264depay', '!', 'h264parse', 'config-interval=-1',
    '!', 'splitmux.video',
  ];
  if (audioConsumer) {
    gstArgs.push(
      'udpsrc', `port=${audioPort}`, `caps=${rtpCapsFor('audio', audioConsumer.rtpParameters)}`,
      '!', 'rtpjitterbuffer', '!', 'rtpopusdepay', '!', 'opusdec',
      '!', 'audioconvert', '!', 'audioresample',
      '!', 'voaacenc', 'bitrate=128000', '!', 'aacparse',
      '!', 'splitmux.audio_0',
    );
  }

  const proc = spawn('gst-launch-1.0', gstArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => console.log(`[ClipRecorder:${streamId}] ${d.toString().trim()}`));
  proc.stderr.on('data', (d) => console.log(`[ClipRecorder:${streamId}] ${d.toString().trim()}`));
  proc.on('exit', (code) => {
    console.log(`[ClipRecorder:${streamId}] gst-launch exited (code=${code})`);
    if (sessions.get(streamId)?.process === proc) sessions.delete(streamId);
  });

  sessions.set(streamId, { process: proc, videoTransport, audioTransport, videoConsumer, audioConsumer, dir });

  // Resume only after gst-launch is spawned (udpsrc up), same margin of
  // safety as hls-manager.js's startHls().
  await videoConsumer.resume();
  if (audioConsumer) await audioConsumer.resume();

  console.log(`[ClipRecorder] ${streamId}: started (video=${videoPort}${audioPort ? ` audio=${audioPort}` : ''}) -> ${dir}`);
}

/** Stop the rolling buffer for `streamId` (no-op if not running) and remove its segment files. */
function stopClipRecording(streamId) {
  const s = sessions.get(streamId);
  if (!s) return;
  sessions.delete(streamId);
  try { s.process.kill('SIGTERM'); } catch (_) {}
  try { s.videoConsumer?.close(); } catch (_) {}
  try { s.audioConsumer?.close(); } catch (_) {}
  try { s.videoTransport?.close(); } catch (_) {}
  try { s.audioTransport?.close(); } catch (_) {}
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (_) {}
  console.log(`[ClipRecorder] ${streamId}: stopped`);
}

function isRecording(streamId) {
  return sessions.has(streamId);
}

function stopAll() {
  for (const streamId of [...sessions.keys()]) stopClipRecording(streamId);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg failed: ${err.message}\n${stderr || ''}`));
      else resolve();
    });
  });
}

/**
 * Extract a single incident clip covering roughly [markTimeMs-5s, markTimeMs+5s]
 * from stream `streamId`'s rolling buffer, losslessly (stream copy, no
 * re-encode) via ffmpeg's concat demuxer, and write it as `<outputBaseName>.mp4`
 * under CLIP_OUTPUT_DIR. Returns the relative filename (to store as
 * incidents.clip_path) on success, or null if the buffer doesn't have
 * (enough) overlapping segments (e.g. recording wasn't running, or the mark
 * happened right at stream start/restart before a full buffer existed).
 *
 * Callers (see index.js's POST /api/qc/incidents/mark) should wait until
 * AFTER the post-roll window has had time to actually land on disk --
 * segments are only picked up once GStreamer closes/finalizes them, which
 * can run a bit past markTimeMs+5s (see SEGMENT_SLACK_MS above) -- before
 * calling this.
 */
async function extractClip(streamId, markTimeMs, outputBaseName) {
  const dir = bufferDirFor(streamId);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return null; // no buffer directory at all -- recording wasn't running
  }

  const windowStart = markTimeMs - PRE_ROLL_MS;
  const windowEnd = markTimeMs + POST_ROLL_MS + SEGMENT_SLACK_MS;

  const matched = entries
    .filter((name) => /^segment\d+\.ts$/.test(name))
    .map((name) => {
      const full = path.join(dir, name);
      let mtimeMs;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) { return null; }
      return { full, mtimeMs };
    })
    .filter((entry) => entry && entry.mtimeMs >= windowStart && entry.mtimeMs <= windowEnd)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  if (matched.length === 0) {
    console.log(`[ClipRecorder] ${streamId}: no buffered segments overlap mark=${markTimeMs} -- skipping clip extraction`);
    return null;
  }

  fs.mkdirSync(CLIP_OUTPUT_DIR, { recursive: true });

  const concatListPath = path.join(os.tmpdir(), `clip-concat-${streamId}-${Date.now()}.txt`);
  const concatList = matched.map((e) => `file '${e.full.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
  fs.writeFileSync(concatListPath, concatList);

  const outputFilename = `${outputBaseName}.mp4`;
  const outputPath = path.join(CLIP_OUTPUT_DIR, outputFilename);

  try {
    await runFfmpeg([
      '-y',
      '-f', 'concat', '-safe', '0', '-i', concatListPath,
      '-c', 'copy', '-movflags', '+faststart',
      outputPath,
    ]);
    console.log(`[ClipRecorder] ${streamId}: extracted clip (${matched.length} segments) -> ${outputPath}`);
    return outputFilename;
  } catch (err) {
    console.error(`[ClipRecorder] ${streamId}: clip extraction failed: ${err.message}`);
    try { fs.unlinkSync(outputPath); } catch (_) {}
    return null;
  } finally {
    try { fs.unlinkSync(concatListPath); } catch (_) {}
  }
}

function clipOutputPath(filename) {
  return path.join(CLIP_OUTPUT_DIR, filename);
}

module.exports = {
  startClipRecording,
  stopClipRecording,
  isRecording,
  stopAll,
  extractClip,
  clipOutputPath,
  CLIP_OUTPUT_DIR,
  POST_ROLL_MS,
  SEGMENT_SLACK_MS,
};
