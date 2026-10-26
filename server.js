// LSharper - local batch quick-editor. No dependencies, just Node + ffmpeg.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PORT = 3000;
const ROOT = __dirname;
const PRESET_FILE = path.join(ROOT, 'presets.json');
const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.wmv', '.flv'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'];

// ---------- locate ffmpeg ----------
function findTool(name) {
  const exe = name + '.exe';
  const probe = spawnSync(name, ['-version']);
  if (!probe.error) return name;
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  const walk = (dir, depth) => {
    if (depth > 4) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === exe) return p;
    }
    for (const e of entries) {
      if (e.isDirectory()) { const r = walk(path.join(dir, e.name), depth + 1); if (r) return r; }
    }
    return null;
  };
  return walk(base, 0) || name;
}
const FFMPEG = findTool('ffmpeg');
const FFPROBE = findTool('ffprobe');
const HAS_NVENC = (() => {
  // listing the encoder isn't enough (driver may be too old), so do a real test encode
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2',
    '-c:v', 'h264_nvenc', '-f', 'null', '-']);
  return !r.error && r.status === 0;
})();

// ---------- filters / args ----------
const num = (v, d) => (Number.isFinite(+v) ? +v : d);

function buildFilter(s) {
  const f = [];
  if (s.upscaleMode === 'factor' && num(s.upscaleFactor, 1) > 1) {
    const k = num(s.upscaleFactor, 1);
    f.push(`scale=trunc(iw*${k}/2)*2:trunc(ih*${k}/2)*2:flags=lanczos`);
  } else if (s.upscaleMode === 'height' && num(s.upscaleHeight, 0) > 0) {
    f.push(`scale=-2:${Math.round(num(s.upscaleHeight, 0))}:flags=lanczos`);
  }
  if (num(s.denoise, 0) > 0) f.push(`hqdn3d=${num(s.denoise, 0)}:${num(s.denoise, 0)}:3:3`);
  if (num(s.sharpness, 0) > 0) f.push(`unsharp=5:5:${num(s.sharpness, 0)}:5:5:0`);
  const sat = num(s.saturation, 1), con = num(s.contrast, 1), bri = num(s.brightness, 0);
  if (sat !== 1 || con !== 1 || bri !== 0) f.push(`eq=saturation=${sat}:contrast=${con}:brightness=${bri}`);
  return f.length ? f.join(',') : 'null';
}

function videoArgs(s) {
  const q = Math.round(num(s.quality, 20));
  if (HAS_NVENC && s.useGpu !== false) {
    return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(q), '-b:v', '0', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(q), '-pix_fmt', 'yuv420p'];
}

function probeDuration(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(String(r.stdout)) || 0;
}

const kindOf = (f) => {
  const e = path.extname(f).toLowerCase();
  return VIDEO_EXT.includes(e) ? 'video' : IMAGE_EXT.includes(e) ? 'image' : null;
};

// ---------- job queue ----------
let jobs = [];
let running = false;
let cancelled = false;
let currentProc = null;

function outPathFor(job, outDir) {
  const p = path.parse(job.file);
  const ext = job.kind === 'video' ? '.mp4' : (p.ext.toLowerCase() === '.png' ? '.png' : '.jpg');
  return path.join(outDir, `${p.name}_enhanced${ext}`);
}

function runJob(job, s, outDir) {
  return new Promise((resolve) => {
    job.status = 'running';
    const out = outPathFor(job, outDir);
    const vf = buildFilter(s);
    const args = ['-hide_banner', '-y', '-i', job.file, '-vf', vf];
    if (job.kind === 'video') {
      args.push(...videoArgs(s), '-c:a', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out);
    } else {
      args.push('-frames:v', '1', ...(out.endsWith('.jpg') ? ['-q:v', '2'] : []), out);
    }
    const duration = job.kind === 'video' ? probeDuration(job.file) : 0;
    const proc = spawn(FFMPEG, args);
    currentProc = proc;
    let errBuf = '';
    proc.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_us=(\d+)/g);
      if (m && duration) {
        const us = parseInt(m[m.length - 1].split('=')[1], 10);
        job.progress = Math.min(99, Math.round((us / 1e6 / duration) * 100));
      }
    });
    proc.stderr.on('data', (d) => { errBuf = (errBuf + d).slice(-2000); });
    proc.on('close', (code) => {
      currentProc = null;
      if (cancelled && code !== 0) { job.status = 'cancelled'; try { fs.unlinkSync(out); } catch {} }
      else if (code === 0) { job.status = 'done'; job.progress = 100; job.output = out; }
      else { job.status = 'error'; job.error = errBuf.split('\n').slice(-4).join('\n'); }
      resolve();
    });
    proc.on('error', (e) => { job.status = 'error'; job.error = e.message; resolve(); });
  });
}

async function runQueue(s, outDir) {
  running = true; cancelled = false;
  fs.mkdirSync(outDir, { recursive: true });
  for (const job of jobs) {
    if (cancelled) { if (job.status === 'queued') job.status = 'cancelled'; continue; }
    if (job.status === 'queued') await runJob(job, s, outDir);
  }
  running = false;
}

// ---------- preview ----------
function frameJpeg(file, kind, vf, seek) {
  const args = ['-hide_banner', '-v', 'error'];
  if (kind === 'video' && seek > 0) args.push('-ss', String(seek));
  args.push('-i', file, '-frames:v', '1', '-vf', vf, '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1');
  const r = spawnSync(FFMPEG, args, { maxBuffer: 64 * 1024 * 1024 });
  return r.stdout && r.stdout.length ? r.stdout.toString('base64') : null;
}

// ---------- helpers ----------
function readPresets() {
  try { return JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8')); } catch { return {}; }
}
function body(req) {
  return new Promise((res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } });
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function browseFolder(start) {
  // script text is passed via -Command (not run as a .ps1 file), start folder via env var
  const script = fs.readFileSync(path.join(ROOT, 'browse.ps1'), 'utf8').replace(/^param\(.*\)\s*$/m, '')
    .replace(/^if \(\$CompileOnly\).*$/m, '').replace('[FolderPicker]::Pick($Start)', '[FolderPicker]::Pick($env:LS_START)');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell', ['-NoProfile', '-STA', '-EncodedCommand', encoded],
    { encoding: 'utf8', env: { ...process.env, LS_START: start || '' } });
  return (r.stdout || '').trim();
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
    }
    if (url.pathname === '/api/info') {
      return send(res, 200, { gpu: HAS_NVENC, ffmpeg: FFMPEG });
    }
    if (url.pathname === '/api/browse') {
      const { start } = await body(req);
      return send(res, 200, { folder: browseFolder(start) });
    }
    if (url.pathname === '/api/scan') {
      const { folder } = await body(req);
      if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory())
        return send(res, 400, { error: 'Folder not found' });
      const files = fs.readdirSync(folder)
        .map((n) => path.join(folder, n))
        .filter((p) => fs.statSync(p).isFile() && kindOf(p))
        .map((p) => ({ file: p, name: path.basename(p), kind: kindOf(p), size: fs.statSync(p).size }));
      return send(res, 200, { files });
    }
    if (url.pathname === '/api/preview') {
      const { file, settings, seek: customSeek } = await body(req);
      const kind = kindOf(file || '');
      if (!kind || !fs.existsSync(file)) return send(res, 400, { error: 'Bad file' });
      const dur = kind === 'video' ? probeDuration(file) : 0;
      const seek = Number.isFinite(+customSeek) && +customSeek >= 0
        ? Math.min(+customSeek, dur > 0 ? dur : +customSeek)
        : Math.min(dur * 0.3, 10);
      return send(res, 200, {
        duration: dur,
        seek,
        before: frameJpeg(file, kind, 'null', seek),
        after: frameJpeg(file, kind, buildFilter(settings || {}), seek),
      });
    }
    if (url.pathname === '/api/start') {
      if (running) return send(res, 409, { error: 'Already running' });
      const { files, settings, outDir } = await body(req);
      if (!files || !files.length) return send(res, 400, { error: 'No files' });
      jobs = files.map((f) => ({ file: f, name: path.basename(f), kind: kindOf(f), status: 'queued', progress: 0 }));
      const out = outDir || path.join(path.dirname(files[0]), 'processed');
      runQueue(settings || {}, out);
      return send(res, 200, { outDir: out });
    }
    if (url.pathname === '/api/status') {
      return send(res, 200, { running, jobs });
    }
    if (url.pathname === '/api/cancel') {
      cancelled = true;
      if (currentProc) currentProc.kill();
      return send(res, 200, {});
    }
    if (url.pathname === '/api/openfolder') {
      const { folder } = await body(req);
      if (folder && fs.existsSync(folder)) spawn('explorer', [folder], { detached: true });
      return send(res, 200, {});
    }
    if (url.pathname === '/api/presets') {
      if (req.method === 'GET') return send(res, 200, readPresets());
      const { name, settings, remove } = await body(req);
      const p = readPresets();
      if (remove) delete p[name]; else p[name] = settings;
      fs.writeFileSync(PRESET_FILE, JSON.stringify(p, null, 2));
      return send(res, 200, p);
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LSharper running at http://localhost:${PORT}  (GPU encode: ${HAS_NVENC ? 'NVENC' : 'off, using CPU'})`);
  if (process.argv.includes('--open')) spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { detached: true, stdio: 'ignore' });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`Port ${PORT} is busy - LSharper may already be running. Open http://localhost:${PORT}`);
  else console.log(e.message);
});
