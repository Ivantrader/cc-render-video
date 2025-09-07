// server.js — produção: CORS robusto + preview rápido + segmentação estável
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

// =========================== APP & CORS ===========================
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "25mb" }));

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// CORS “duro” (sempre setar cabeçalhos)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// CORS do pacote (por compatibilidade)
app.use(cors({
  origin: CORS_ORIGIN,
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","Accept"],
  credentials: false,
  optionsSuccessStatus: 204
}));

// Log curto
app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.path}`); next(); });

// =========================== STATIC ===========================
const FILES_DIR = path.join(os.tmpdir(), "render-files");
fs.mkdirSync(FILES_DIR, { recursive: true });
app.use("/files", express.static(FILES_DIR));

const tmpFile = (ext) => tmp.fileSync({ postfix: ext }).name;
const writeText = (text, ext) => { const p = tmpFile(ext); fs.writeFileSync(p, text, "utf-8"); return p; };
const guessBaseUrl = (req) => process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

// =========================== HEALTH & TEST ===========================
app.get("/", (_req, res) => res.type("text").send("OK - cc-render-video"));
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.options(["/render_video","/render_segment","/test_post"], (_req, res) => res.sendStatus(204));

app.post("/test_post", (req, res) => {
  res.json({ ok: true, cors: true, echo: req.body || null, time: new Date().toISOString() });
});

// =========================== HELPERS (FFmpeg) ===========================
function hms(t) {
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
}

async function synthTTS(segments = []) {
  // Gera silêncio igual ao total dos trechos (fallback estável)
  const total = segments.reduce((a, s) => a + Math.max(0, (s.t1 || 0) - (s.t0 || 0)), 0) || 10;
  const wav = tmpFile(".wav");
  await new Promise((resolve, reject) => {
    ffmpeg().input("anullsrc=r=48000:cl=stereo").inputFormat("lavfi")
      .outputOptions(["-t", String(total)])
      .audioCodec("pcm_s16le")
      .save(wav).on("end", resolve).on("error", reject);
  });
  return wav;
}

async function solidNoText({ width, height, duration }) {
  const out = tmpFile(".mp4");
  const bg = `color=c=black:s=${width}x${height}:r=30:d=${duration}`;
  await new Promise((resolve, reject) => {
    ffmpeg().input(bg).inputFormat("lavfi")
      .outputOptions(["-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-movflags", "+faststart"])
      .save(out).on("end", resolve).on("error", reject);
  });
  return out;
}

async function segmentSolid({ text, width, height, duration }) {
  const out = tmpFile(".mp4");
  const bg = `color=c=black:s=${width}x${height}:r=30:d=${duration}`;
  const fontPath = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const safe = (text || "").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const draw = `drawtext=fontfile=${fontPath}:text='${safe}':fontcolor=white:fontsize=58:box=1:boxcolor=0x00000088:x=(w-text_w)/2:y=(h-text_h)/2`;
  try {
    await new Promise((resolve, reject) => {
      ffmpeg().input(bg).inputFormat("lavfi").videoFilters(draw)
        .outputOptions(["-pix_fmt","yuv420p","-c:v","libx264","-preset","veryfast","-crf","25","-movflags","+faststart"])
        .save(out).on("end", resolve).on("error", reject);
    });
    return out;
  } catch (e) {
    console.warn("[drawtext] falhou, fallback sólido:", String(e));
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
    ffmpeg(img).videoFilters(filter).loop(duration).size(`${width}x${height}`).fps(30)
      .outputOptions(["-pix_fmt","yuv420p","-c:v","libx264","-preset","veryfast","-crf","25","-movflags","+faststart"])
      .save(out).on("end", resolve).on("error", reject);
  });
  return out;
}

async function muxAudio(videoPath, voicePath, musicOn, duckVol = 0.35) {
  const out = tmpFile(".mp4");
  const cmd = ffmpeg(videoPath).input(voicePath);
  if (musicOn) cmd.input("anullsrc=r=48000:cl=stereo").inputFormat("lavfi");
  const outputs = musicOn
    ? ["-filter_complex", `[1:a]volume=1.0[a1];[2:a]volume=${duckVol}[a2];[a1][a2]amix=inputs=2:normalize=0[aout]`, "-map","0:v","-map","[aout]"]
    : ["-map","0:v","-map","1:a"];
  await new Promise((resolve, reject) => {
    cmd.outputOptions(outputs).videoCodec("copy").audioCodec("aac").save(out)
      .on("end", resolve).on("error", reject);
  });
  return out;
}

async function cut10s(inputPath) {
  const out = tmpFile(".mp4");
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath).outputOptions(["-t","10"]).save(out).on("end", resolve).on("error", reject);
  });
  return out;
}

async function savePublic(filePath, fileName, req) {
  const dest = path.join(FILES_DIR, fileName);
  fs.copyFileSync(filePath, dest);
  return `${guessBaseUrl(req)}/files/${encodeURIComponent(fileName)}`;
}

// =========================== /render_video (preview/final simples) ===========================
app.post("/render_video", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const mode = body.mode || "preview";
    const format = body.format === "16:9" ? "16:9" : "9:16";
    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;
    const timeline = body.timeline || { duration: 45, tracks: {} };

    // prévia ultra-rápida (10s)
    const out = tmpFile(".mp4");
    try {
      await new Promise((resolve, reject) => {
        ffmpeg().input(`color=black:s=${W}x${H}:r=30:d=10`).inputFormat("lavfi")
          .videoFilters("drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='PREVIEW 10s':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=0x00000088")
          .outputOptions(["-pix_fmt","yuv420p","-c:v","libx264","-preset","veryfast","-crf","25","-movflags","+faststart"])
          .save(out).on("end", resolve).on("error", reject);
      });
    } catch {
      await new Promise((resolve, reject) => {
        ffmpeg().input(`color=black:s=${W}x${H}:r=30:d=10`).inputFormat("lavfi")
          .outputOptions(["-pix_fmt","yuv420p","-c:v","libx264","-preset","veryfast","-crf","25","-movflags","+faststart"])
          .save(out).on("end", resolve).on("error", reject);
      });
    }
    const urlPrev = await savePublic(out, `preview_10s_${format.replace(":","x")}.mp4`, req);
    return res.json({ preview_mp4: urlPrev, debug: { fast: true, took_ms: Date.now() - started } });
  } catch (err) {
    console.error("[/render_video] erro:", err);
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.status(500).json({ error: "render_failed", detail: String(err?.message || err) });
  }
});

// =========================== /render_segment (a solução que você vai usar no app) ===========================
/*
  POST /render_segment
  {
    "format": "9:16" | "16:9",
    "timeline": { "duration": 30, "fps": 30, "tracks": { video:[...], voiceover:[...], ... } },
    "segment": { "index": 0, "length": 8 }   // index*length = início da janela
  }
  Gera um MP4 de <length>s (default 8s) — estável no Free tier.
*/
app.post("/render_segment", async (req, res) => {
  try {
    const body = req.body || {};
    const format = body.format === "16:9" ? "16:9" : "9:16";
    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;

    const timeline = body.timeline || { duration: 30, fps: 30, tracks: {} };
    const seg = body.segment || { index: 0, length: 8 };
    const index = Math.max(0, Number(seg.index) || 0);
    const length = Math.max(2, Math.min(15, Number(seg.length) || 8)); // 2..15s
    const start = index * length;

    // Fallback estável: fundo preto com rótulo do segmento
    let videoPath = await segmentSolid({
      text: `SEG ${index + 1} • ${length}s`,
      width: W,
      height: H,
      duration: length
    });

    // Áudio: silêncio (ou no futuro, TTS real)
    const voicePath = await synthTTS([{ t0: 0, t1: length }]);

    // mux
    const withAudio = await muxAudio(videoPath, voicePath, false);
    const url = await savePublic(withAudio, `segment_${index + 1}_${length}s_${format.replace(":","x")}.mp4`, req);
    return res.json({ mp4: url, start_s: start, length_s: length });
  } catch (err) {
    console.error("[/render_segment] erro:", err);
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.status(500).json({ error: "segment_failed", detail: String(err?.message || err) });
  }
});

// =========================== GLOBAL HANDLERS ===========================
process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("render_video up on", PORT));
