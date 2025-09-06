// server.js
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

const app = express();
app.use(express.json({ limit: "25mb" }));

// ———————————————————————————————————
// CORS garantido em TUDO (inclui erros)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
// ———————————————————————————————————

const FILES_DIR = path.join(os.tmpdir(), "render-files");
fs.mkdirSync(FILES_DIR, { recursive: true });
app.use("/files", express.static(FILES_DIR));

const tmpFile = (ext) => tmp.fileSync({ postfix: ext }).name;
const writeText = (text, ext) => {
  const p = tmpFile(ext);
  fs.writeFileSync(p, text, "utf-8");
  return p;
};
const guessBaseUrl = (req) =>
  process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

// SRT util
function buildSRT(caps = []) {
  const fmt = (t) => {
    const ms = Math.floor((t - Math.floor(t)) * 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
      s
    ).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  };
  let i = 1;
  const out = [];
  for (const c of caps)
    out.push(String(i++), `${fmt(c.t0)} --> ${fmt(c.t1)}`, c.text || "", "");
  return out.join("\n");
}

// TTS fake (silêncio)
async function synthTTS(segments = [], voice = "BR-M1") {
  const total =
    segments.reduce(
      (a, s) => a + Math.max(0, (s.t1 || 0) - (s.t0 || 0)),
      0
    ) || 10;
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

// Fallback sólido com texto (sem egress)
async function segmentSolid({ text, width, height, duration }) {
  const out = tmpFile(".mp4");
  const bg = `color=c=black:s=${width}x${height}:r=30:d=${duration}`;
  const safe =
    (text || "Cena").replace(/:/g, "\\:").replace(/'/g, "\\'").slice(0, 60);
  const draw = `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${safe}':fontcolor=white:fontsize=48:box=1:boxcolor=0x00000088:x=(w-text_w)/2:y=(h-text_h)/2`;
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(bg)
      .inputFormat("lavfi")
      .videoFilters(draw)
      .outputOptions(["-pix_fmt yuv420p"])
      .save(out)
      .on("end", resolve)
      .on("error", reject);
  });
  return out;
}

// Ken Burns leve a partir de imagem (opcional)
async function segmentFromImage({ url, width, height, duration }) {
  const img = tmpFile(path.extname(url) || ".jpg");
  const { data } = await axios.get(url, { responseType: "arraybuffer", timeout: 15000 });
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
      .outputOptions(["-pix_fmt yuv420p"])
      .save(out)
      .on("end", resolve)
      .on("error", reject);
  });
  return out;
}

// Gera segmentos de vídeo com fallback seguro
async function buildVideoSegments(videoTracks = [], width, height) {
  const segs = [];
  for (const v of videoTracks) {
    const dur = Math.max(0.2, (v.t1 || 0) - (v.t0 || 0) || 3);
    let seg;
    try {
      if (v.src && /^image:/i.test(v.src)) {
        const url = v.src.replace(/^image:/i, "");
        seg = await segmentFromImage({ url, width, height, duration: dur });
      } else {
        // “broll:…” ou qualquer outro → sólido com texto
        seg = await segmentSolid({
          text: (v.src || "Cena").replace(/^broll:/i, ""),
          width,
          height,
          duration: dur,
        });
      }
    } catch (err) {
      console.error("segment error:", err);
      seg = await segmentSolid({ text: "Cena", width, height, duration: dur });
    }
    segs.push(seg);
  }
  return segs;
}

async function concatSegments(paths = []) {
  if (!paths.length) throw new Error("Sem segmentos de vídeo");
  const list = writeText(paths.map((p) => `file '${p}'`).join("\n"), ".txt");
  const out = tmpFile(".mp4");
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(list)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy"])
      .save(out)
      .on("end", resolve)
      .on("error", reject);
  });
  return out;
}

async function muxAudio(videoPath, voicePath, musicOn, duckVol = 0.35) {
  const out = tmpFile(".mp4");
  const cmd = ffmpeg(videoPath).input(voicePath);
  if (musicOn)
    cmd.input("anullsrc=r=48000:cl=stereo").inputFormat("lavfi");
  const outputs = musicOn
    ? [
        "-filter_complex",
        `[1:a]volume=1.0[a1];[2:a]volume=${duckVol}[a2];[a1][a2]amix=inputs=2:normalize=0[aout]`,
        "-map",
        "0:v",
        "-map",
        "[aout]",
      ]
    : ["-map", "0:v", "-map", "1:a"];
  await new Promise((resolve, reject) => {
    cmd
      .outputOptions(outputs)
      .videoCodec("copy")
      .audioCodec("aac")
      .save(out)
      .on("end", resolve)
      .on("error", reject);
  });
  return out;
}

async function cut10s(inputPath) {
  const out = tmpFile(".mp4");
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(["-t 10"])
      .save(out)
      .on("end", resolve)
      .on("error", reject);
  });
  return out;
}

async function savePublic(filePath, fileName, req) {
  const dest = path.join(FILES_DIR, fileName);
  fs.copyFileSync(filePath, dest);
  return `${guessBaseUrl(req)}/files/${encodeURIComponent(fileName)}`;
}

// ——— Rotas básicas
app.get("/", (_req, res) => res.type("text").send("OK - cc-render-video"));
app.get("/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// ——— Render principal
app.post("/render_video", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // redundante por segurança
  try {
    const body = req.body || {};
    const { mode = "preview", format = "9:16", captions = true, timeline = {} } = body;
    const { fps = 30, duration = 45, tracks = {} } = timeline;

    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;

    // 1) VOZ (silêncio por enquanto)
    const voice = await synthTTS(tracks.voiceover || [], (tracks.voiceover?.[0]?.voice) || "BR-M1");

    // 2) VÍDEO (sem egress por padrão, só se vier image:)
    const segs = await buildVideoSegments(tracks.video || [], W, H);
    const videoConcat = await concatSegments(segs);

    // 3) ÁUDIO
    const withAudio = await muxAudio(videoConcat, voice, !!(tracks.music && tracks.music.length));

    // Preview curto
    if (mode === "preview") {
      const pv = await cut10s(withAudio);
      const urlPrev = await savePublic(pv, `preview_10s_${format.replace(":", "x")}.mp4`, req);
      return res.json({ preview_mp4: urlPrev });
    }

    // SRT opcional
    let srtUrl = null;
    if (captions && tracks.captions?.length) {
      const srtFile = writeText(buildSRT(tracks.captions), ".srt");
      srtUrl = await savePublic(srtFile, "captions.srt", req);
    }

    const urlFinal = await savePublic(
      withAudio,
      `video_final_${format.replace(":", "x")}_${duration}s.mp4`,
      req
    );
    const thumbs = await (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thumbs-"));
      const pts = ["00:00:02", "00:00:05", "00:00:08"];
      const names = ["thumb_A.jpg", "thumb_B.jpg", "thumb_C.jpg"];
      const urls = [];
      for (let i = 0; i < 3; i++) {
        const f = path.join(dir, `t${i}.jpg`);
        await new Promise((resolve, reject) => {
          ffmpeg(withAudio)
            .screenshots({ timestamps: [pts[i]], filename: path.basename(f), folder: path.dirname(f), size: "1280x720" })
            .on("end", resolve)
            .on("error", reject);
        });
        urls.push(await savePublic(f, names[i], req));
      }
      return urls;
    })();

    return res.json({ final_mp4: urlFinal, srt: srtUrl, thumbs });
  } catch (err) {
    console.error("render_failed:", err);
    return res.status(500).json({ error: "render_failed", detail: String(err?.message || err) });
  }
});

// Não deixar cair por rejeições não tratadas
process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT:", e));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("render_video up on", PORT));
