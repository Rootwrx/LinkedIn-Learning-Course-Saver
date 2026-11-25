'use strict';

// MPEG-TS (H.264 + AAC) -> MP4 remuxer. No re-encoding, no dependencies.
//
// Why a plain rename or concat does not work:
//  - TS timestamps use a 90 kHz clock, start at an arbitrary value, wrap at 2^33
//    and may restart from one HLS segment to the next. MP4 stores *durations*.
//    A negative difference written into an unsigned 32-bit field becomes
//    2^32 / 90000 = 13h15m21s.
//  - TS carries H.264 as start-code delimited NAL units with SPS/PPS in-band.
//    MP4 needs length-prefixed NAL units plus an avcC box built from SPS/PPS,
//    otherwise there is no picture.
//  - TS carries AAC with an ADTS header per frame. MP4 needs the headers removed
//    and described once in an esds box.
(function (global) {
  const CLOCK = 90000;
  const WRAP = 8589934592; // 2^33
  const HALF_WRAP = WRAP / 2;
  const MAX_BACKWARD = 0.1 * CLOCK; // larger jumps between segments are
  const MAX_FORWARD = 1.5 * CLOCK; //  treated as a timestamp discontinuity
  const MOVIE_SCALE = 1000;
  const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000, 7350];

  function concat(list) {
    let size = 0;
    for (const item of list) size += item.length;
    const out = new Uint8Array(size);
    let offset = 0;
    for (const item of list) {
      out.set(item, offset);
      offset += item.length;
    }
    return out;
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* ------------------------------ H.264 ------------------------------ */

  // Split an Annex B stream into NAL units (without start codes).
  function splitNals(data) {
    const nals = [];
    let start = -1;
    let i = 0;
    while (i + 2 < data.length) {
      if (data[i + 2] > 1) {
        i += 3;
      } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        if (start >= 0) pushNal(nals, data, start, i);
        i += 3;
        start = i;
      } else {
        i++;
      }
    }
    if (start >= 0) pushNal(nals, data, start, data.length);
    return nals;
  }

  function pushNal(nals, data, start, end) {
    // Trailing zeros belong to the next start code, not to this NAL.
    while (end > start && data[end - 1] === 0) end--;
    if (end > start) nals.push(data.subarray(start, end));
  }

  function bitReader(nal) {
    // Remove emulation prevention bytes (00 00 03).
    const bytes = [];
    for (let i = 0; i < nal.length; i++) {
      if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
      bytes.push(nal[i]);
    }
    let pos = 0;
    function bit() {
      if (pos >= bytes.length * 8) throw new Error('Truncated H.264 header');
      const value = (bytes[pos >> 3] >> (7 - (pos & 7))) & 1;
      pos++;
      return value;
    }
    function bits(n) {
      let value = 0;
      for (let i = 0; i < n; i++) value = value * 2 + bit();
      return value;
    }
    function ue() {
      let zeros = 0;
      while (!bit()) {
        if (++zeros > 31) throw new Error('Invalid H.264 header');
      }
      return Math.pow(2, zeros) - 1 + bits(zeros);
    }
    function se() {
      const value = ue();
      return value & 1 ? (value + 1) / 2 : -value / 2;
    }
    return { bit, bits, ue, se };
  }

  function parseSps(nal) {
    const r = bitReader(nal.subarray(1));
    const profile = r.bits(8);
    r.bits(16); // constraint flags + level
    const id = r.ue();
    let chroma = 1;
    let separatePlanes = 0;
    let depthLuma = 0;
    let depthChroma = 0;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = r.ue();
      if (chroma === 3) separatePlanes = r.bit();
      depthLuma = r.ue();
      depthChroma = r.ue();
      r.bit();
      if (r.bit()) {
        for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
          if (!r.bit()) continue;
          let last = 8;
          let next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            if (next !== 0) last = next;
          }
        }
      }
    }
    r.ue(); // log2_max_frame_num
    const pocType = r.ue();
    if (pocType === 0) {
      r.ue();
    } else if (pocType === 1) {
      r.bit();
      r.se();
      r.se();
      const count = r.ue();
      for (let i = 0; i < count; i++) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.bit();
    const widthMbs = r.ue() + 1;
    const heightUnits = r.ue() + 1;
    const frameOnly = r.bit();
    if (!frameOnly) r.bit();
    r.bit();
    let left = 0;
    let right = 0;
    let top = 0;
    let bottom = 0;
    if (r.bit()) {
      left = r.ue();
      right = r.ue();
      top = r.ue();
      bottom = r.ue();
    }
    const type = separatePlanes ? 0 : chroma;
    const unitX = type === 1 || type === 2 ? 2 : 1;
    const unitY = (type === 1 ? 2 : 1) * (2 - frameOnly);
    let sar = [1, 1];
    try {
      if (r.bit() && r.bit()) { // VUI present, aspect ratio present
        const idc = r.bits(8);
        const table = [[1, 1], [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11],
          [20, 11], [32, 11], [80, 33], [18, 11], [15, 11], [64, 33], [160, 99],
          [4, 3], [3, 2], [2, 1]];
        if (idc === 255) sar = [r.bits(16), r.bits(16)];
        else if (table[idc]) sar = table[idc];
        if (!sar[0] || !sar[1]) sar = [1, 1];
      }
    } catch (_) { /* VUI is optional */ }
    return {
      id: id,
      profile: profile,
      chroma: chroma,
      depthLuma: depthLuma,
      depthChroma: depthChroma,
      width: widthMbs * 16 - (left + right) * unitX,
      height: (2 - frameOnly) * heightUnits * 16 - (top + bottom) * unitY,
      sar: sar,
    };
  }

  function hasRecoveryPoint(sei) {
    return sei.length > 1 && sei[1] === 6;
  }

  /* ------------------------------ MP4 boxes -------------------------- */

  function u8(...values) { return Uint8Array.from(values); }
  function u16(v) { return u8((v >> 8) & 255, v & 255); }
  function u32(v) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, v >>> 0);
    return out;
  }
  function u64(v) { return concat([u32(Math.floor(v / 4294967296)), u32(v % 4294967296)]); }
  function ascii(s) { return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
  function zeros(n) { return new Uint8Array(n); }
  function box(type, ...payload) {
    const body = concat(payload);
    return concat([u32(body.length + 8), ascii(type), body]);
  }
  function fullBox(type, version, flags, ...payload) {
    return box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);
  }
  function table(values) {
    const out = new Uint8Array(values.length * 4);
    const view = new DataView(out.buffer);
    for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i] >>> 0);
    return out;
  }
  const MATRIX = table([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]);

  function runLength(values) {
    const out = [];
    for (const value of values) {
      if (out.length && out[out.length - 1] === value) out[out.length - 2]++;
      else out.push(1, value);
    }
    return out;
  }

  function descriptor(tag, ...payload) {
    const body = concat(payload);
    return concat([u8(tag, body.length), body]);
  }

  function audioEntry(audio) {
    const config = u8(
      (audio.objectType << 3) | (audio.rateIndex >> 1),
      ((audio.rateIndex & 1) << 7) | (audio.channels << 3)
    );
    const esds = fullBox('esds', 0, 0, descriptor(3,
      u16(0), u8(0),
      descriptor(4, u8(0x40, 0x15, 0, 0, 0), u32(0), u32(0), descriptor(5, config)),
      descriptor(6, u8(2))));
    return box('mp4a', zeros(6), u16(1), zeros(8), u16(audio.channels || 2), u16(16),
      zeros(4), u32((audio.rate > 65535 ? 0 : audio.rate) * 65536), esds);
  }

  function videoEntry(video) {
    const first = video.info;
    const sets = (list) => concat(list.map((nal) => concat([u16(nal.length), nal])));
    const sps = Array.from(video.sps.values());
    const pps = Array.from(video.pps.values());
    const config = [u8(1, sps[0][1], sps[0][2], sps[0][3], 0xff, 0xe0 | sps.length), sets(sps),
      u8(pps.length), sets(pps)];
    if ([100, 110, 122, 144].includes(first.profile)) {
      config.push(u8(0xfc | first.chroma, 0xf8 | first.depthLuma, 0xf8 | first.depthChroma, 0));
    }
    return box('avc1', zeros(6), u16(1), zeros(16), u16(first.width), u16(first.height),
      u32(0x00480000), u32(0x00480000), zeros(4), u16(1), zeros(32), u16(24), u16(0xffff),
      box('avcC', ...config),
      box('pasp', u32(first.sar[0]), u32(first.sar[1])));
  }

  function trackBox(track, id, chunkOffsets, useCo64) {
    const isVideo = track.kind === 'video';
    const count = track.sizes.length;
    const toMovie = (v) => Math.round(v * MOVIE_SCALE / track.timescale);

    const edits = [];
    // The edit covers presentation time, which with B-frames ends later than
    // the decode timeline does.
    const shown = toMovie(Math.max(0, track.shownEnd - track.mediaStart));
    if (track.delay > 0) edits.push(u32(toMovie(track.delay)), u32(0xffffffff), u32(0x10000));
    edits.push(u32(shown), u32(track.mediaStart), u32(0x10000));
    const total = toMovie(track.delay) + shown;

    const stbl = [fullBox('stsd', 0, 0, u32(1),
      isVideo ? videoEntry(track) : audioEntry(track))];
    const stts = runLength(track.durations);
    stbl.push(fullBox('stts', 0, 0, u32(stts.length / 2), table(stts)));
    if (isVideo) {
      if (track.offsets.some((v) => v !== 0)) {
        const ctts = runLength(track.offsets);
        const version = track.offsets.some((v) => v < 0) ? 1 : 0;
        stbl.push(fullBox('ctts', version, 0, u32(ctts.length / 2), table(ctts)));
      }
      if (track.keys.length && track.keys.length < count) {
        stbl.push(fullBox('stss', 0, 0, u32(track.keys.length), table(track.keys)));
      }
    }
    const stsc = [];
    track.chunks.forEach((chunk, i) => {
      if (!stsc.length || stsc[stsc.length - 2] !== chunk.samples) {
        stsc.push(i + 1, chunk.samples, 1);
      }
    });
    stbl.push(fullBox('stsc', 0, 0, u32(stsc.length / 3), table(stsc)));
    stbl.push(fullBox('stsz', 0, 0, u32(0), u32(count), table(track.sizes)));
    stbl.push(useCo64
      ? fullBox('co64', 0, 0, u32(chunkOffsets.length), concat(chunkOffsets.map(u64)))
      : fullBox('stco', 0, 0, u32(chunkOffsets.length), table(chunkOffsets)));

    const width = isVideo
      ? Math.round(track.info.width * track.info.sar[0] / track.info.sar[1]) : 0;
    const height = isVideo ? track.info.height : 0;

    return {
      duration: total,
      data: box('trak',
        fullBox('tkhd', 0, 7, u32(0), u32(0), u32(id), u32(0), u32(total), zeros(8),
          u16(0), u16(isVideo ? 0 : 1), u16(isVideo ? 0 : 0x100), u16(0), MATRIX,
          u32(width * 65536), u32(height * 65536)),
        box('edts', fullBox('elst', 0, 0, u32(edits.length / 3), ...edits)),
        box('mdia',
          fullBox('mdhd', 0, 0, u32(0), u32(0), u32(track.timescale), u32(track.duration),
            u16(0x55c4), u16(0)),
          fullBox('hdlr', 0, 0, u32(0), ascii(isVideo ? 'vide' : 'soun'), zeros(12),
            ascii(isVideo ? 'VideoHandler\0' : 'SoundHandler\0')),
          box('minf',
            isVideo ? fullBox('vmhd', 0, 1, zeros(8)) : fullBox('smhd', 0, 0, zeros(4)),
            box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
            box('stbl', ...stbl)))),
    };
  }

  /* ------------------------------ Remuxer ---------------------------- */

  function createRemuxer() {
    const video = {
      kind: 'video', timescale: CLOCK, sps: new Map(), pps: new Map(), info: null,
      sizes: [], dts: [], pts: [], keys: [], chunks: [],
    };
    const audio = {
      kind: 'audio', timescale: 0, rate: 0, rateIndex: 0, channels: 0, objectType: 2,
      sizes: [], durations: [], chunks: [],
    };

    let pmtPid = -1;
    let videoPid = -1;
    let audioPid = -1;
    const unsupported = new Set();
    const pesBuffers = new Map();
    const mediaChunks = []; // Blobs, in file order

    let lastRaw = null; // for 33-bit unwrapping
    let offset = 0; // added to source time to get output time
    let videoNext = null; // expected output DTS of the next video frame
    let audioNext = null; // expected output PTS of the next audio frame
    let videoStep = 3000;
    let audioStart = null; // output PTS of the first audio frame
    let audioEnd = 0; // samples written, in audio timescale
    let audioLeft = new Uint8Array(0);
    let audioClock = null;
    let started = false; // true once the first keyframe was found

    let segVideo = [];
    let segAudio = [];
    let pendingVideo = null;

    function unwrap(value, reference) {
      if (reference == null) return value;
      return value + Math.round((reference - value) / WRAP) * WRAP;
    }

    /* ---- PSI + PES ---- */

    function readSection(payload) {
      const start = 1 + payload[0];
      const length = ((payload[start + 1] & 0x0f) << 8) | payload[start + 2];
      return payload.subarray(start, Math.min(payload.length, start + 3 + length));
    }

    function readPat(payload) {
      const s = readSection(payload);
      for (let i = 8; i + 4 <= s.length - 4; i += 4) {
        if (((s[i] << 8) | s[i + 1]) !== 0) {
          pmtPid = ((s[i + 2] & 0x1f) << 8) | s[i + 3];
          return;
        }
      }
    }

    function readPmt(payload) {
      const s = readSection(payload);
      let i = 12 + (((s[10] & 0x0f) << 8) | s[11]);
      while (i + 5 <= s.length - 4) {
        const type = s[i];
        const pid = ((s[i + 1] & 0x1f) << 8) | s[i + 2];
        if (type === 0x1b) {
          if (videoPid < 0) videoPid = pid;
        } else if (type === 0x0f) {
          if (audioPid < 0) audioPid = pid;
        } else if ([0x01, 0x02, 0x03, 0x04, 0x10, 0x11, 0x24, 0x81, 0x87,
          0xcf, 0xdb].includes(type)) {
          unsupported.add('0x' + type.toString(16).padStart(2, '0'));
        }
        i += 5 + (((s[i + 3] & 0x0f) << 8) | s[i + 4]);
      }
    }

    function readTimestamp(d, i) {
      return (d[i] & 0x0e) * 536870912 + d[i + 1] * 4194304 + (d[i + 2] & 0xfe) * 16384 +
        d[i + 3] * 128 + (d[i + 4] >> 1);
    }

    function flushPes(pid) {
      const parts = pesBuffers.get(pid);
      if (!parts) return;
      pesBuffers.delete(pid);
      const data = concat(parts);
      if (data.length < 9 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return;
      let end = data.length;
      const declared = (data[4] << 8) | data[5];
      if (declared) end = Math.min(end, 6 + declared);
      const flags = data[7] >> 6;
      const payload = data.subarray(9 + data[8], end);
      let pts = null;
      let dts = null;
      if (flags & 2) {
        pts = unwrap(readTimestamp(data, 9), lastRaw);
        dts = flags === 3 ? unwrap(readTimestamp(data, 14), pts) : pts;
        lastRaw = dts;
      }
      if (pid === videoPid) videoPes(payload, pts, dts);
      else audioPes(payload, pts);
    }

    function demux(data) {
      let i = 0;
      let packets = 0;
      while (i + 188 <= data.length) {
        if (data[i] !== 0x47 || (i + 188 < data.length && data[i + 188] !== 0x47)) {
          i++;
          continue;
        }
        const packet = data.subarray(i, i + 188);
        i += 188;
        packets++;
        if (packet[1] & 0x80) continue; // transport error
        const first = !!(packet[1] & 0x40);
        const pid = ((packet[1] & 0x1f) << 8) | packet[2];
        const adaptation = (packet[3] >> 4) & 3;
        if (!(adaptation & 1)) continue;
        const begin = adaptation & 2 ? 5 + packet[4] : 4;
        if (begin >= 188) continue;
        const payload = packet.subarray(begin);

        if (pid === 0) {
          if (first) readPat(payload);
        } else if (pid === pmtPid) {
          if (first) readPmt(payload);
        } else if (pid === videoPid || pid === audioPid) {
          if (packet[3] & 0xc0) throw new Error('The stream is encrypted.');
          if (first) {
            flushPes(pid);
            pesBuffers.set(pid, [payload]);
          } else if (pesBuffers.has(pid)) {
            pesBuffers.get(pid).push(payload);
          }
        }
      }
      return packets;
    }

    /* ---- video ---- */

    // A PES normally holds one frame. If a frame spills into further PES
    // packets, join them before looking for NAL units.
    function videoPes(payload, pts, dts) {
      const startsUnit = payload[0] === 0 && payload[1] === 0 &&
        (payload[2] === 1 || (payload[2] === 0 && payload[3] === 1));
      if (pts != null && startsUnit) {
        finishVideoFrame();
        pendingVideo = { parts: [payload], pts: pts, dts: dts };
      } else if (pendingVideo) {
        pendingVideo.parts.push(payload);
      }
    }

    function finishVideoFrame() {
      if (!pendingVideo) return;
      const frame = pendingVideo;
      pendingVideo = null;
      const out = [];
      let key = false;
      let slice = false;
      for (const nal of splitNals(concat(frame.parts))) {
        const type = nal[0] & 0x1f;
        if (type === 9 || type === 10 || type === 11 || type === 12) continue;
        if (type === 7) {
          const info = parseSps(nal);
          if (!video.info) video.info = info;
          if (!video.sps.has(info.id)) video.sps.set(info.id, nal.slice());
        } else if (type === 8) {
          const id = bitReader(nal.subarray(1)).ue();
          if (!video.pps.has(id)) video.pps.set(id, nal.slice());
        } else if (type === 5) {
          key = true;
        } else if (type === 6 && hasRecoveryPoint(nal)) {
          key = true;
        }
        if (type >= 1 && type <= 5) slice = true;
        out.push(u32(nal.length), nal);
      }
      if (!slice) return;
      // Decoding must start on a keyframe with known SPS/PPS.
      if (!started) {
        if (!key || !video.info || !video.pps.size) return;
        started = true;
      }
      segVideo.push({ data: concat(out), pts: frame.pts, dts: frame.dts, key: key });
    }

    /* ---- audio ---- */

    function audioPes(payload, pts) {
      const startsFrame = payload[0] === 0xff && (payload[1] & 0xf6) === 0xf0;
      const carried = startsFrame ? 0 : audioLeft.length;
      const data = carried ? concat([audioLeft, payload]) : payload;
      let i = 0;
      let stamped = false;
      while (i + 7 <= data.length) {
        if (data[i] !== 0xff || (data[i + 1] & 0xf6) !== 0xf0) {
          i++;
          continue;
        }
        const header = data[i + 1] & 1 ? 7 : 9;
        const length = ((data[i + 3] & 3) << 11) | (data[i + 4] << 3) | (data[i + 5] >> 5);
        if (length <= header) {
          i++;
          continue;
        }
        if (i + length > data.length) break;
        const rateIndex = (data[i + 2] >> 2) & 15;
        const rate = AAC_RATES[rateIndex];
        if (!rate) {
          i++;
          continue;
        }
        if (!audio.rate) {
          audio.rate = rate;
          audio.timescale = rate;
          audio.rateIndex = rateIndex;
          audio.objectType = (data[i + 2] >> 6) + 1;
          audio.channels = ((data[i + 2] & 1) << 2) | (data[i + 3] >> 6);
        } else if (rate !== audio.rate) {
          throw new Error('The audio sample rate changes in the middle of the stream.');
        }
        // The PES timestamp belongs to the first frame that *starts* in it.
        if (!stamped && i >= carried && pts != null) {
          audioClock = pts;
          stamped = true;
        }
        if (audioClock != null) {
          segAudio.push({ data: data.slice(i + header, i + length), pts: audioClock });
          audioClock += 1024 * CLOCK / rate;
        }
        i += length;
      }
      audioLeft = data.slice(i);
    }

    /* ---- timeline ---- */

    // Place one segment on the output timeline. Audio and video always share the
    // same offset, so their relative sync is exactly what the source had.
    function placeSegment() {
      if (!segVideo.length && !segAudio.length) return;
      const v = segVideo.length ? segVideo[0].dts : null;
      const a = segAudio.length ? segAudio[0].pts : null;

      if (videoNext == null && audioNext == null) {
        offset = -(v != null ? v : a);
      } else {
        const useVideo = v != null && videoNext != null;
        const useAudio = a != null && audioNext != null;
        if (useVideo || useAudio) {
          const delta = useVideo ? v + offset - videoNext : a + offset - audioNext;
          if (delta < -MAX_BACKWARD || delta > MAX_FORWARD) {
            const candidates = [];
            if (useVideo) candidates.push(videoNext - v);
            if (useAudio) candidates.push(audioNext - a);
            offset = Math.max(...candidates);
          }
        }
      }

      if (segVideo.length) {
        const data = [];
        let bytes = 0;
        for (const frame of segVideo) {
          let dts = frame.dts + offset;
          let pts = frame.pts + offset;
          const previous = video.dts.length ? video.dts[video.dts.length - 1] : null;
          if (previous != null) {
            if (dts <= previous) {
              pts += previous + 1 - dts;
              dts = previous + 1;
            } else if (dts - previous < CLOCK) {
              videoStep = dts - previous;
            }
          }
          video.dts.push(dts);
          video.pts.push(pts);
          video.sizes.push(frame.data.length);
          if (frame.key) video.keys.push(video.sizes.length);
          data.push(frame.data);
          bytes += frame.data.length;
        }
        videoNext = video.dts[video.dts.length - 1] + videoStep;
        video.chunks.push({ index: mediaChunks.length, samples: data.length, bytes: bytes });
        mediaChunks.push(new Blob(data));
      }

      if (segAudio.length) {
        const data = [];
        let bytes = 0;
        for (const frame of segAudio) {
          const pts = frame.pts + offset;
          if (audioStart == null) audioStart = pts;
          const target = Math.round((pts - audioStart) * audio.rate / CLOCK);
          const drift = target - audioEnd;
          if (drift <= -1024) continue; // overlapping audio: drop the frame
          if (drift > audio.rate / 50 && audio.durations.length) {
            // Real gap (> 20 ms): stretch the previous frame to stay in sync.
            audio.durations[audio.durations.length - 1] += drift;
            audioEnd += drift;
          }
          audio.durations.push(1024);
          audio.sizes.push(frame.data.length);
          audioEnd += 1024;
          data.push(frame.data);
          bytes += frame.data.length;
        }
        if (data.length) {
          audioNext = audioStart + audioEnd * CLOCK / audio.rate;
          audio.chunks.push({ index: mediaChunks.length, samples: data.length, bytes: bytes });
          mediaChunks.push(new Blob(data));
        }
      }
      segVideo = [];
      segAudio = [];
    }

    function push(segment) {
      const packets = demux(segment);
      if (!packets) throw new Error('A stream part is not MPEG-TS data.');
      // HLS segments are self-contained: complete everything before the next one.
      if (videoPid >= 0) flushPes(videoPid);
      if (audioPid >= 0) flushPes(audioPid);
      finishVideoFrame();
      placeSegment();
    }

    function finish() {
      const found = unsupported.size
        ? ' (unsupported stream types: ' + Array.from(unsupported).join(', ') + ')' : '';
      if (!video.sizes.length) {
        throw new Error('No H.264 video was found in this stream' + found + '.');
      }
      if (!audio.sizes.length && (audioPid >= 0 || unsupported.size)) {
        throw new Error('The audio track could not be read' + found + '.');
      }

      // Video: MP4 stores the gap between consecutive decode times.
      const base = video.dts[0];
      video.durations = video.dts.map((dts, i) =>
        (i + 1 < video.dts.length ? video.dts[i + 1] - dts : videoStep));
      video.offsets = video.pts.map((pts, i) => pts - video.dts[i]);
      video.duration = video.dts[video.dts.length - 1] + videoStep - base;
      let firstShown = Infinity;
      let lastShown = -Infinity;
      for (const pts of video.pts) {
        if (pts < firstShown) firstShown = pts;
        if (pts > lastShown) lastShown = pts;
      }
      // The movie starts on the first picture.
      video.mediaStart = Math.max(0, firstShown - base);
      video.shownEnd = lastShown + videoStep - base;
      video.delay = 0;

      const tracks = [video];
      if (audio.sizes.length) {
        const lead = audioStart - Math.max(firstShown, base);
        audio.duration = audioEnd;
        audio.shownEnd = audioEnd;
        audio.delay = lead > 0 ? Math.round(lead * audio.rate / CLOCK) : 0;
        audio.mediaStart = lead < 0 ? Math.round(-lead * audio.rate / CLOCK) : 0;
        tracks.push(audio);
      }

      let mediaBytes = 0;
      const positions = new Array(mediaChunks.length);
      for (const track of tracks) {
        for (const chunk of track.chunks) positions[chunk.index] = chunk.bytes;
      }
      for (let i = 0; i < positions.length; i++) {
        const size = positions[i];
        positions[i] = mediaBytes;
        mediaBytes += size;
      }

      const useCo64 = mediaBytes > 4000000000;
      const ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isomiso2avc1mp41'));
      const mdatHeader = useCo64
        ? concat([u32(1), ascii('mdat'), u64(mediaBytes + 16)])
        : concat([u32(mediaBytes + 8), ascii('mdat')]);

      function buildMoov(dataStart) {
        const built = tracks.map((track, i) => trackBox(track, i + 1,
          track.chunks.map((chunk) => dataStart + positions[chunk.index]), useCo64));
        const duration = Math.max(...built.map((item) => item.duration));
        return box('moov',
          fullBox('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_SCALE), u32(duration),
            u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(tracks.length + 1)),
          ...built.map((item) => item.data));
      }

      // moov goes first (fast start); its size does not depend on the offsets.
      const size = buildMoov(0).length;
      const moov = buildMoov(ftyp.length + size + mdatHeader.length);

      return {
        blob: new Blob([ftyp, moov, mdatHeader, ...mediaChunks], { type: 'video/mp4' }),
        info: {
          width: video.info.width,
          height: video.info.height,
          frames: video.sizes.length,
          audioFrames: audio.sizes.length,
          seconds: video.duration / CLOCK,
        },
      };
    }

    return { push: push, finish: finish };
  }

  global.LLSRemux = { createRemuxer: createRemuxer };
})(globalThis);
