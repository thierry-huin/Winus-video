const os = require('os');

module.exports = {
  worker: {
    rtcMinPort: parseInt(process.env.RTP_MIN_PORT || '10201', 10),
    rtcMaxPort: parseInt(process.env.RTP_MAX_PORT || '10400', 10),
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp'],
    // Docker/containerd disables the io_uring syscalls by default (security
    // hardening, see https://github.com/containerd/containerd/issues/9048).
    // mediasoup-worker >= 3.14.0 auto-detects kernel >= 6 and tries to use
    // io_uring regardless, which crashes with "io_uring_queue_init() failed:
    // Operation not permitted" (worker exits with code:40) the moment a
    // Router/Producer is created inside such a container -- exactly what
    // happened in production (kernel 6.17 host, default Docker seccomp).
    // Explicitly disabling liburing avoids depending on the container's
    // seccomp profile at all (the officially recommended fix, see
    // https://github.com/versatica/mediasoup/issues/1435).
    disableLiburing: true,
  },
  // One worker per CPU core (video is heavier than audio)
  numWorkers: Math.min(os.cpus().length, 4),
  router: {
    mediaCodecs: [
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f', // Baseline 3.1
          'level-asymmetry-allowed': 1,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '4d0032', // Main 5.0 (high quality)
          'level-asymmetry-allowed': 1,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '640032', // High 5.0 (AMD AMF hardware encoder output)
          'level-asymmetry-allowed': 1,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
      },
      // HEVC (H.265) -- optional, opt-in from the publisher's GUI (see the
      // "HEVC" checkbox in installer/video_publisher.py) despite narrower
      // browser/device decode support than H.264 (notably: Firefox and many
      // Android Chrome builds can't decode HEVC via WebRTC at all). Only
      // ONE registered profile, unlike H.264's three -- mediasoup does not
      // special-case H.265 profile/level matching in its SDP/RTP capability
      // negotiation the way it does for H.264 (profile-level-id) or VP9
      // (profile-id), so this entry mainly needs matching mimeType/clockRate;
      // the parameters below are RFC 7798's conservative Main
      // profile/Main tier/Level 3.1 defaults (profile-id=1, tier-flag=0,
      // level-id=93), matching what tools/publish.js sends. tx-mode=SRST
      // (single RTP stream per session) is the only mode this app ever uses.
      // NOT wired into hls-manager.js's HLS output (H.264-only passthrough,
      // see that file) -- the publisher-side GUI auto-disables the HLS
      // checkbox whenever HEVC is selected, and hls-manager.js also no-ops
      // (logs + skips) if it ever gets asked to start HLS for an HEVC
      // Producer anyway, as a server-side safety net.
      {
        kind: 'video',
        mimeType: 'video/H265',
        clockRate: 90000,
        parameters: {
          'profile-id': 1,
          'tier-flag': 0,
          'level-id': 93,
          'tx-mode': 'SRST',
        },
      },
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
        // stereo/sprop-stereo: without these, Chrome negotiates audio as
        // mono regardless of channels=2, and silently downmixes any
        // genuinely stereo incoming audio (the main program feed, captured
        // via a real 2-channel source -- NOT the commentator's own
        // return mic, which stays mono) before JS ever sees it. See
        // tools/publish.js's main audio producer, which must declare the
        // same parameters for this to take effect end-to-end.
        parameters: {
          stereo: 1,
          'sprop-stereo': 1,
        },
      },
    ],
  },
  webRtcTransport: {
    maxIncomingBitrate: 20_000_000, // 20 Mbps max
    initialAvailableOutgoingBitrate: 5_000_000, // 5 Mbps initial
  },
};
