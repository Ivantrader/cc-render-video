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

// CORS para permitir chamadas do Base44 (ou qualquer origem HTTPS)
app.use(cors({ origin: true }));
app.options("*", cors());

// aceitar JSON grande
app.use(express.json({ limit: "25mb" }));

// pasta pública para servir os arquivos (prévia, final, thumbs, srt)
const FILES_DIR = path.join(os.tmpdir(), "render-files");
fs.mkdirSync(FILES_DIR, { recursive: true });
app.use("/files", express.static(FILES_DIR));

const tmpFile = (ext) => tmp.fileSync({ postfix: ext }).name;
const writeText = (text, ext) => { const p = tmpFile(ext); fs.writeFileSync(p, text, "utf-8"); return p; };

const guessBaseUrl = (req) => process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

function buildSRT(caps=[]) {
  const fmt = (t)=> {
    const ms = Math.floor((t - Math.floor(t))*1000);
    const h = Math.floor(t/3600), m = Math.floor((t%3600)/60), s = Math.floor(t%60);
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
  };
  let i=1, out=[];
  for (const c of caps) out.push(String(i++), `${fmt(c.t0)} --> ${fmt(c.t1)}`, c.text||"", "");
  return out.join("\n");
}

async function synthTTS(segments=[], voice="BR-M1") {
  const total = segments.reduce((a,s)=> a + Math.max(0, (s.t1||0)-(s.t0||0)), 0) || 10;
  const wav = tmpFile(".wav");
  await new Promise((resolve, reject) => {
    ffmpeg().input("anullsrc=r=48000:cl=stereo").inputFormat("lavfi")
      .outputOptions(["-t", String(total)])
      .audioCodec("pcm_s16le")
      .save(wav).on("end", resolve).on("error", reject);
  });
  return wav;
}

async function segmentSolid({ text, width, height, duration }) {
  const out = tmpFile(".mp4");
  const bg = `color=c=black:s=${width}x${height}:r=30:d=${duration}`;
  const safe = (text||"").replace(/:/g,"\\:").replace(/'/g,"\\'");
  const draw = `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${safe}':fontcolor=white:fontsize=48:box=1:boxcolor=0x00000088:x=(w-text_w)/2:y=(h-text_h)/2`;
  await new Promise((resolve,reject)=>{
    ffmpeg().input(bg).inputFormat("lavfi").videoFilters(draw)
      .outputOptions(["-pix_fmt yuv420p"]).save(out).on("end",resolve).on("error",reject);
  });
  return out;
}

async function segmentFromImage({ url, width, height, duration }) {
  const img = tmpFile(path.extname(url)||".jpg");
  const { data } = await axios.get(url, { responseType: "arraybuffer" });
  fs.writeFileSync(img, data);
  const out = tmpFile(".mp4");
  const frames = Math.max(1, Math.round(duration*30));
  const filter = `zoompan=z='min(zoom+0.0015,1.05)':d=${frames}:s=${width}x${height}`;
  await new Promise((resolve,reject)=>{
    ffmpeg(img).videoFilters(filter).loop(duration).size(`${width}x${height}`).fps(30)
      .outputOptions(["-pix_fmt yuv420p"]).save(out).on("end",resolve).on("error",reject);
  });
  return out;
}

async function buildVideoSegments(videoTracks, width, height) {
  const segs = [];
  for (const v of (videoTracks||[])) {
    const dur = Math.max(0.2, (v.t1||0)-(v.t0||0) || 3);
    let seg;
    try {
      if (v.src && v.src.startsWith("image:")) {
        seg = await segmentFromImage({ url: v.src.slice(6), width, height, duration: dur });
      } else {
        seg = await segmentSolid({ text: (v.src||"Cena").replace("broll:",""), width, height, duration: dur });
      }
    } catch {
      seg = await segmentSolid({ text: "Cena", width, height, duration: dur });
    }
    segs.push(seg);
  }
  return segs;
}

async function concatSegments(paths) {
  const list = writeText(paths.map(p=>`file '${p}'`).join("\n"), ".txt");
  const out = tmpFile(".mp4");
  await new Promise((resolve,reject)=>{
    ffmpeg().input(list).inputOptions(["-f concat","-safe 0"]).outputOptions(["-c copy"])
      .save(out).on("end",resolve).on("error",reject);
  });
  return out;
}

async function muxAudio(videoPath, voicePath, musicOn, duckVol=0.35) {
  const out = tmpFile(".mp4");
  const cmd = ffmpeg(videoPath).input(voicePath);
  if (musicOn) cmd.input("anullsrc=r=48000:cl=stereo").inputFormat("lavfi");
  const outputs = musicOn
    ? ["-filter_complex", `[1:a]volume=1.0[a1];[2:a]volume=${duckVol}[a2];[a1][a2]amix=inputs=2:normalize=0[aout]`, "-map","0:v","-map","[aout]"]
    : ["-map","0:v","-map","1:a"];
  await new Promise((resolve,reject)=>{
    cmd.outputOptions(outputs).videoCodec("copy").audioCodec("aac").save(out)
      .on("end",resolve).on("error",reject);
  });
  return out;
}

async function cut10s(inputPath) {
  const out = tmpFile(".mp4");
  await new Promise((resolve,reject)=>{
    ffmpeg(inputPath).outputOptions(["-t 10"]).save(out).on("end",resolve).on("error",reject);
  });
  return out;
}

async function savePublic(filePath, fileName, req) {
  const dest = path.join(FILES_DIR, fileName);
  fs.copyFileSync(filePath, dest);
  return `${guessBaseUrl(req)}/files/${encodeURIComponent(fileName)}`;
}

async function extractThumbs(inputPath, req) {
  const ts = ["00:00:02","00:00:05","00:00:08"];
  const outNames = ["thumb_A.jpg","thumb_B.jpg","thumb_C.jpg"];
  const urls = [];
  for (let i=0;i<3;i++) {
    const f = tmpFile(".jpg");
    await new Promise((resolve,reject)=>{
      ffmpeg(inputPath).screenshots({ timestamps:[ts[i]], filename:path.basename(f), folder:path.dirname(f), size:"1280x720" })
        .on("end",resolve).on("error",reject);
    });
    urls.push(await savePublic(f, outNames[i], req));
  }
  return urls;
}

// Rotas utilitárias
app.get("/", (_,res)=> res.type("text").send("OK - cc-render-video"));
app.get("/health", (_,res)=> res.json({ ok:true, time:new Date().toISOString() }));

// Render principal
app.post("/render_video", async (req,res)=>{
  try {
    console.log("POST /render_video", req.body?.mode, req.body?.format);
    const { mode="preview", format="9:16", timeline={}, captions=true } = req.body || {};
    const { fps=30, duration=45, tracks={} } = timeline;
    const W = format==="9:16" ? 1080 : 1920;
    const H = format==="9:16" ? 1920 : 1080;

    const voicePath = await synthTTS(tracks.voiceover || [], (tracks.voiceover?.[0]?.voice)||"BR-M1");
    const segs = await buildVideoSegments(tracks.video || [], W, H);
    const concatPath = await concatSegments(segs);
    const withAudio = await muxAudio(concatPath, voicePath, !!(tracks.music && tracks.music.length));

    if (mode==="preview") {
      const pv = await cut10s(withAudio);
      const urlPrev = await savePublic(pv, `preview_10s_${format.replace(":","x")}.mp4`, req);
      return res.json({ preview_mp4: urlPrev });
    }

    let srtUrl = null;
    if (captions && tracks.captions?.length) {
      const srtText = buildSRT(tracks.captions);
      const srtFile = writeText(srtText, ".srt");
      srtUrl = await savePublic(srtFile, "captions.srt", req);
    }

    const finalUrl = await savePublic(withAudio, `video_final_${format.replace(":","x")}_${duration}s.mp4`, req);
    const thumbs = await extractThumbs(withAudio, req);

    res.json({ final_mp4: finalUrl, srt: srtUrl, thumbs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "render_failed", detail: String(e?.message||e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log("render_video up on", PORT));
