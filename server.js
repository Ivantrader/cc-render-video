// server.js — API de render com CORS robusto + render por SEGMENTO (4/8/10s)

// ====== Imports ======
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";
import tmp from "tmp";
import axios from "axios";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";

ffmpeg.setFfmpegPath(ffmpegPath);

// ====== App & CORS ======
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "25mb" }));

// CORS robusto (inclui OPTIONS e erros)
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    credentials: false,
    optionsSuccessStatus: 204,
  })
);

app.set("trust proxy", true);

// Log simples
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// ====== Static ======
const FILES_DIR = path.join(os.tmpdir(), "render-files");
fs.mkdirSync(FILES_DIR, { recursive: true });
app.use("/files", express.static(FILES_DIR));

const tmpFile = (ext) => tmp.fileSync({ postfix: ext }).name;
const writeText = (text, ext) => {
  const p = tmpFile(ext);
  fs.writeFileSync(p, text, "utf-8");
  return p;
};
const guessBaseUrl = (req) => process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

// ====== Health & Test ======
app.get("/", (_req, res) => res.type("text").send("OK - cc-render-video"));
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.post("/test_post", (req, res) => res.json({ ok: true, cors: true, echo: req.body || null, time: new Date().toISOString() }));

// ====== Helpers ======
function buildSRT(caps = []) {
  const fmt = (t) => {
    const ms = Math.floor((t - Math.floor(t)) * 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  };
  let i = 1;
  const out = [];
  for (const c of caps) out.push(String(i++), `${fmt(c.t0)} --> ${fmt(c.t1)}`, c.text || "", "");
  return out.join("\n");
}

async function synthTTS(segments = []) {
  // gera silêncio do tamanho do trecho (para simplificar no Free tier)
  const total = segments.reduce((a, s) => a + Math.max(0, (s.t1 || 0) - (s.t0 || 0)), 0) || 10;
  const wav = tmpFile(".wav");
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input("anullsrc=r=48000:cl=stereo")
      .inputFormat("lavfi")
      .outputOptions(["-t", String(total)])
      .audioCodec("pcm_s16le")
      .save(wav)
      .on("end", resolve)
      .on("error", reject);
  });
  return wav;
}

async function solidNoText({ width, height, duration }) {
  const out = tmpFile(".mp4");
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(`color=c=black:s=${width}x${height}:r=30:d=${duration}`)
      .inputFormat("lavfi")
      .outputOptions(["-pix_fmt", "yuv420p"])
      .save(out)
      .on("end", resolve)
      .on("error", reject);
  });
  return out;
}

async function segmentSolid({ text, width, height, duration }) {
  const out = tmpFile(".mp4");
  const bg = `color=c=black:s=${width}x${height}:r=30:d=${duration}`;
  const fontPath = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const safe = (text || "").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const draw =
    `drawtext=fontfile=${fontPath}:` +
    `text='${safe}':fontcolor=white:fontsize=48:box=1:boxcolor=0x00000088:` +
    `x=(w-text_w)/2:y=(h-text_h)/2`;
  try {
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(bg)
        .inputFormat("lavfi")
        .videoFilters(draw)
        .outputOptions(["-pix_fmt", "yuv420p"])
        .save(out)
        .on("end", resolve)
        .on("error", reject);
    });
    return out;
  } catch {
    return solidNoText({ width, height, duration });
  }
}

async function segmentFromImage({ url, width, height, duration }) {
  const img = tmpFile(path.extname(url) || ".jpg");
  const { data } = await axios.get(url, { responseType: "arraybuffer" });
  fs.writeFileSync(img, data);
  const out = tmpFile(".mp4");
  const frames = Math.max(1, Math.round(duration * 30));
  const filter = `zoompan=z='min(zoom+0.0015,1.05)':d=${frames}:s=${width}x${height}`;
  await new Promise((resolve, reject) => {
    ffmpeg(img)
      .videoFilters(filter)
      .loop(duration)
      .size(`${width}x${height}`)
      .fps(30)
      .outputOptions(["-pix_fmt", "yuv420p"])
      .save(out)
      .on("end", resolve)
      .on("error", reject);
  });
  return out;
}

async function buildVideoSegments(videoTracks = [], width, height) {
  const segs = [];
  for (const v of videoTracks) {
    const dur = Math.max(0.2, (v.t1 || 0) - (v.t0 || 0) || 3);
    let seg;
    try {
      if (v.src && v.src.startsWith("image:")) {
        seg = await segmentFromImage({ url: v.src.slice(6), width, height, duration: dur });
      } else {
        // Usa o texto do b-roll como rótulo simples
        const clean = (v.src || "")
          .replace(/[<>]/g, "")
          .replace(/data-[^=\s]+="[^"]*"/g, "")
          .replace(/^broll:/, "");
        seg = await segmentSolid({ text: clean || "Cena", width, height, duration: dur });
      }
    } catch {
      seg = await solidNoText({ width, height, duration: dur });
    }
    segs.push(seg);
  }
  return segs;
}

async function concatSegments(segPaths = []) {
  if (!segPaths.length) throw new Error("Sem segmentos de vídeo");
  const listFile = writeText(segPaths.map((p) => `file '${p}'`).join("\n"), ".txt");
  const out = tmpFile(".mp4");
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions([
        "-r 30",
        "-pix_fmt yuv420p",
        "-c:v libx264",
        "-preset ultrafast",   // leve para Free tier
        "-crf 28",
        "-movflags +faststart",
        "-threads 1"
      ])
      .save(out)
      .on("stderr", (l) => console.log("[ffmpeg concat]", String(l || "").trim()))
      .on("end", resolve)
      .on("error", reject);
  });
  return out;
}

async function muxAudio(videoPath, voicePath, musicOn, duckVol = 0.35) {
  const out = tmpFile(".mp4");
  const cmd = ffmpeg(videoPath).input(voicePath);
  if (musicOn) cmd.input("anullsrc=r=48000:cl=stereo").inputFormat("lavfi");
  const outputs = musicOn
    ? [
        "-filter_complex",
        `[1:a]volume=1.0[a1];[2:a]volume=${duckVol}[a2];[a1][a2]amix=inputs=2:normalize=0[aout]`,
        "-map", "0:v",
        "-map", "[aout]",
      ]
    : ["-map", "0:v", "-map", "1:a"];
  await new Promise((resolve, reject) => {
    cmd.outputOptions(outputs).videoCodec("copy").audioCodec("aac").save(out).on("end", resolve).on("error", reject);
  });
  return out;
}

async function cutTo(inputPath, seconds) {
  const out = tmpFile(".mp4");
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath).outputOptions(["-t", String(seconds)]).save(out).on("end", resolve).on("error", reject);
  });
  return out;
}

async function savePublic(filePath, fileName, req) {
  const dest = path.join(FILES_DIR, fileName);
  fs.copyFileSync(filePath, dest);
  return `${guessBaseUrl(req)}/files/${encodeURIComponent(fileName)}`;
}

async function extractThumbs(inputPath, req) {
  const ts = ["00:00:02", "00:00:05", "00:00:08"];
  const outNames = ["thumb_A.jpg", "thumb_B.jpg", "thumb_C.jpg"];
  const urls = [];
  for (let i = 0; i < 3; i++) {
    const f = tmpFile(".jpg");
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .screenshots({ timestamps: [ts[i]], filename: path.basename(f), folder: path.dirname(f), size: "1280x720" })
        .on("end", resolve)
        .on("error", reject);
    });
    urls.push(await savePublic(f, outNames[i], req));
  }
  return urls;
}

// ====== Slices (recorta timeline para segmento) ======
function sliceTrackArray(arr = [], t0, t1) {
  const out = [];
  for (const it of arr || []) {
    const a = Math.max(t0, it.t0 || 0);
    const b = Math.min(t1, it.t1 || 0);
    if (b > a) out.push({ ...it, t0: a - t0, t1: b - t0 });
  }
  return out;
}

function sliceTimeline(timeline = {}, t0 = 0, t1 = 10) {
  const tracks = timeline.tracks || {};
  return {
    fps: timeline.fps || 30,
    duration: Math.max(0, t1 - t0),
    tracks: {
      voiceover: sliceTrackArray(tracks.voiceover, t0, t1),
      captions: sliceTrackArray(tracks.captions, t0, t1),
      video: sliceTrackArray(tracks.video, t0, t1),
      graphics: sliceTrackArray(tracks.graphics, t0, t1),
      // música: se houver, liga música de fundo no segmento (não recorta faixas externas)
      music: (tracks.music && tracks.music.length) ? [{ src: "cc0_auto", vol: tracks.music[0].vol ?? 0.35, t0: 0, t1: Math.max(0, t1 - t0) }] : []
    }
  };
}

// ====== Preview/Final ======
app.post("/render_video", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const mode = body.mode || "preview";
    const format = body.format === "16:9" ? "16:9" : "9:16";
    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;
    const timeline = body.timeline || { tracks: {} };

    const forceRealPreview = String(process.env.FORCE_REAL_PREVIEW || "0") === "1";
    const useQuick = mode === "preview" && !forceRealPreview;

    console.log("[/render_video] start", { mode, format, useQuick, forceRealPreview });

    // PREVIEW 10s rápido
    if (useQuick) {
      const out = tmpFile(".mp4");
      try {
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(`color=black:s=${W}x${H}:r=30:d=10`)
            .inputFormat("lavfi")
            .videoFilters("drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='PREVIEW 10s':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=0x00000088")
            .outputOptions(["-pix_fmt yuv420p", "-c:v libx264", "-preset ultrafast", "-crf 28", "-movflags +faststart", "-threads 1"])
            .save(out)
            .on("end", resolve)
            .on("error", reject);
        });
      } catch {
        // fallback sem texto
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(`color=black:s=${W}x${H}:r=30:d=10`)
            .inputFormat("lavfi")
            .outputOptions(["-pix_fmt yuv420p", "-c:v libx264", "-preset ultrafast", "-crf 28", "-movflags +faststart", "-threads 1"])
            .save(out)
            .on("end", resolve)
            .on("error", reject);
        });
      }
      const urlPrev = await savePublic(out, `preview_10s_${format.replace(":", "x")}.mp4`, req);
      return res.json({ preview_mp4: urlPrev, debug: { fast: true, took_ms: Date.now() - started } });
    }

    // FINAL (pode pesar no Free, prefira /render_segment)
    const W2 = W, H2 = H;
    const voicePath = await synthTTS(timeline.tracks?.voiceover || []);
    const segs = await buildVideoSegments(
      timeline.tracks?.video || [{ t0: 0, t1: Math.min(10, timeline.duration || 10), src: "broll:Preview" }],
      W2,
      H2
    );
    const videoConcat = await concatSegments(segs);
    const withAudio = await muxAudio(videoConcat, voicePath, !!(timeline.tracks?.music && timeline.tracks.music.length));

    if (mode === "preview") {
      const pv = await cutTo(withAudio, 10);
      const urlPrev = await savePublic(pv, `preview_10s_${format.replace(":", "x")}.mp4`, req);
      return res.json({ preview_mp4: urlPrev, debug: { fast: false, took_ms: Date.now() - started } });
    }

    // modo final
    const duration = timeline.duration || 0;
    const finalUrl = await savePublic(withAudio, `video_final_${format.replace(":", "x")}_${duration || "X"}s.mp4`, req);
    const thumbs = await extractThumbs(withAudio, req);

    let srtUrl = null;
    if (body.captions && timeline.tracks?.captions?.length) {
      const srtFile = writeText(buildSRT(timeline.tracks.captions), ".srt");
      srtUrl = await savePublic(srtFile, "captions.srt", req);
    }

    res.json({ final_mp4: finalUrl, srt: srtUrl, thumbs, debug: { took_ms: Date.now() - started } });
  } catch (err) {
    console.error("[/render_video] erro:", err);
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.status(500).json({ error: "render_failed", detail: String(err?.message || err) });
  }
});

// ====== NOVO: render de SEGMENTO ======
app.post("/render_segment", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const format = body.format === "16:9" ? "16:9" : "9:16";
    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;
    const timeline = body.timeline || { duration: 10, tracks: {} };
    const seg = body.segment || { index: 0, length: 8 };

    const total = timeline.duration || 0;
    const t0 = Math.max(0, (seg.index || 0) * (seg.length || 8));
    const t1 = Math.min(total || (t0 + (seg.length || 8)), t0 + (seg.length || 8));

    const sliced = sliceTimeline(timeline, t0, t1);

    const voicePath = await synthTTS(sliced.tracks.voiceover || []);
    const segs = await buildVideoSegments(sliced.tracks.video || [{ t0: 0, t1: sliced.duration || 4, src: "broll:Segmento" }], W, H);
    const videoConcat = await concatSegments(segs);
    const withAudio = await muxAudio(videoConcat, voicePath, !!(sliced.tracks.music && sliced.tracks.music.length));

    const fileName = `seg_${String(seg.index).padStart(3, "0")}_${(t1 - t0)}s_${format.replace(":", "x")}.mp4`;
    const mp4 = await savePublic(withAudio, fileName, req);

    let srtUrl = null;
    if (sliced.tracks.captions?.length) {
      const srtFile = writeText(buildSRT(sliced.tracks.captions), ".srt");
      srtUrl = await savePublic(srtFile, `seg_${String(seg.index).padStart(3, "0")}.srt`, req);
    }

    res.json({
      ok: true,
      mp4,
      srt: srtUrl,
      index: seg.index || 0,
      length: seg.length || 8,
      start: t0,
      end: t1,
      debug: { took_ms: Date.now() - started }
    });
  } catch (err) {
    console.error("[/render_segment] erro:", err);
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.status(500).json({ ok: false, error: "segment_failed", detail: String(err?.message || err) });
  }
});

// ====== Global error hooks ======
process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("render_video up on", PORT));
