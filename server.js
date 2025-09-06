// server.js — Preview 10s sempre no caminho rápido + CORS robusto
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";
import tmp from "tmp";
import axios from "axios";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";

// ---- proteção: loga qualquer crash cedo
process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "25mb" }));

// ---- CORS forte, inclusive preflight
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With"],
    credentials: false,
    optionsSuccessStatus: 204,
  })
);

// ---- log básico
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// ---- estáticos em /files
const FILES_DIR = path.join(os.tmpdir(), "render-files");
fs.mkdirSync(FILES_DIR, { recursive: true });
app.use("/files", express.static(FILES_DIR));
const tmpFile = (ext) => tmp.fileSync({ postfix: ext }).name;

const guessBaseUrl = (req) =>
  process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

// ---- health & teste
app.get("/", (_req, res) => res.type("text").send("OK - cc-render-video"));
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.post("/test_post", (req, res) => res.json({ ok: true, echo: req.body, time: new Date().toISOString() }));

// ==== FUNÇÕES AUXILIARES DE FFMPEG ====

function makeBlackPreview({ width, height, seconds, label = "PREVIEW 10s" }) {
  const out = tmpFile(".mp4");
  const color = `color=black:s=${width}x${height}:r=30:d=${seconds}`;
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(color)
      .inputFormat("lavfi")
      .videoFilters(
        `drawtext=fontfile=${font}:text='${label.replace(/'/g, "\\'")}':` +
          `fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2:` +
          `box=1:boxcolor=0x00000088`
      )
      .outputOptions(["-pix_fmt yuv420p", "-c:v libx264", "-preset veryfast", "-crf 25", "-movflags +faststart"])
      .save(out)
      .on("end", () => resolve(out))
      .on("stderr", (l) => {
        const s = String(l || "").trim();
        if (s) console.log("[ffmpeg preview]", s);
      })
      .on("error", (err) => reject(err));
  });
}

async function savePublic(filePath, fileName, req) {
  const dest = path.join(FILES_DIR, fileName);
  fs.copyFileSync(filePath, dest);
  return `${guessBaseUrl(req)}/files/${encodeURIComponent(fileName)}`;
}

// ==== ROTA DE RENDER ====

app.post("/render_video", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const mode = body.mode || "preview";
    const format = body.format === "16:9" ? "16:9" : "9:16";
    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;

    // 🔒 PARA ESTABILIZAR: SEMPRE usar caminho rápido para preview
    const useQuick = (mode === "preview");
    console.log("[/render_video] start", { mode, format, useQuick });

    if (useQuick) {
      try {
        const mp4 = await makeBlackPreview({ width: W, height: H, seconds: 10 });
        const url = await savePublic(mp4, `preview_10s_${format.replace(":", "x")}.mp4`, req);
        return res.json({ preview_mp4: url, debug: { fast: true, took_ms: Date.now() - started } });
      } catch (err) {
        console.error("[preview quick] erro:", err);
        // fallback simples: retorna 204 para o cliente se quiser tratar
        return res.status(500).json({ error: "preview_failed", detail: String(err?.message || err) });
      }
    }

    // (se no futuro quiser pipeline completo para preview, mover a lógica aqui)

    return res.status(400).json({ error: "bad_mode", detail: "Modo não suportado nesta build." });
  } catch (err) {
    console.error("[/render_video] erro:", err);
    // sempre devolve com CORS
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    return res.status(500).json({ error: "render_failed", detail: String(err?.message || err) });
  }
});

// ==== START ====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("render_video up on", PORT));
