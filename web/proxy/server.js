// Gem Finder web slice 1: thin proxy over the Python CLI.
//
// POST /scan accepts a photo, shells out to cli.py, and returns the CLI's
// ranked-candidates JSON unchanged. The Meta API key lives in this
// process's environment only (MODEL_API_KEY) and is passed solely to the
// CLI child on live runs; it never reaches the client.
//
// Modes (?mode=): live (default), dry (CLI --dry-run, $0), stub (banked
// report, $0, photo optional). Also serves the static PWA build.
const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { costRange } = require('./cost.js');
const {
  assembleFallback, extractAssessment, fallbackParseError, mineCloseupErr,
} = require('./extract.js');
const { loadApiKey } = require('./apikey.js');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8741);
const BANKED_REPORT = process.env.BANKED_REPORT ||
  path.join(REPO, 'runs', 'reports', 'dry.20261029T232604Z.json');
const DEMO_PHOTO = process.env.DEMO_PHOTO ||
  path.join(REPO, 'assets', 'testbed', 'dry.jpg');
const DIST = path.join(REPO, 'web', 'pwa', 'dist');
const REPORTS_DIR = path.join(REPO, 'runs', 'reports');

// Persistent key: explicit env first, ~/.model_api_key file next. Loaded
// once at start so no restart can silently lose live scans. Only the
// source is ever logged — never the value.
const apiKey = loadApiKey();
if (apiKey.key) process.env.MODEL_API_KEY = apiKey.key;
console.error(apiKey.key
  ? `MODEL_API_KEY: live-available (source: ${apiKey.source})`
  : 'MODEL_API_KEY missing: live scans unavailable (projection/dry/demo still work)');

const app = express();
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`));
  next();
});

app.get('/health', (req, res) => res.json({
  ok: true,
  key: !!process.env.MODEL_API_KEY,
  live_available: !!process.env.MODEL_API_KEY,
  banked: fs.existsSync(BANKED_REPORT),
  demoPhoto: fs.existsSync(DEMO_PHOTO),
  ui: fs.existsSync(path.join(DIST, 'index.html')),
  now: new Date().toISOString(),
}));

app.get('/demo/photo', (req, res, next) => {
  if (!fs.existsSync(DEMO_PHOTO)) {
    return res.status(503).json({ error: 'demo photo unavailable' });
  }
  res.sendFile(DEMO_PHOTO);
});

app.get('/demo/report', (req, res) => {
  fs.readFile(BANKED_REPORT, 'utf8', (err, data) => {
    if (err) return res.status(503).json({ error: 'banked report unavailable' });
    res.type('json').send(data);
  });
});

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('photo must be an image file'));
  },
});

function runCli(photoPath, { dryRun }) {
  return new Promise((resolve, reject) => {
    const fail = (status, message) => reject(Object.assign(new Error(message), { status }));
    const args = ['cli.py', photoPath];
    if (dryRun) args.push('--dry-run');
    const env = { ...process.env };
    if (dryRun) {
      delete env.MODEL_API_KEY; // dry runs make zero calls; fail-safe
    } else if (!env.MODEL_API_KEY) {
      return fail(503, 'MODEL_API_KEY not set on proxy; live scans unavailable');
    }
    const child = spawn(path.join(REPO, '.venv', 'bin', 'python'), args, { cwd: REPO, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => fail(500, `cli spawn failed: ${e.message}`));
    child.on('close', (code) => {
      if (code !== 0) return fail(500, `cli exit ${code}: ${err.slice(-500)}`);
      const m = out.match(/^\s*report:\s*(.+)$/m);
      if (!m) return fail(500, 'cli did not print a report path');
      const reportPath = path.resolve(REPO, m[1].trim());
      if (!reportPath.startsWith(REPORTS_DIR + path.sep)) {
        return fail(500, 'cli report path outside reports dir');
      }
      fs.readFile(reportPath, 'utf8', (e, data) => {
        if (e) return fail(500, `cannot read cli report: ${e.message}`);
        try {
          JSON.parse(data);
        } catch (parseErr) {
          return fail(500, `cli report is not JSON: ${parseErr.message}`);
        }
        resolve(data); // raw bytes: response is byte-identical to the CLI report
      });
    });
  });
}

function runProjection(photoPath, kind) {
  return new Promise((resolve, reject) => {
    const fail = (status, message) => reject(Object.assign(new Error(message), { status }));
    // No API key needed or used: --project reads dimensions and exits
    // before any SAM or Spark call.
    const env = { ...process.env };
    delete env.MODEL_API_KEY;
    const child = spawn(path.join(REPO, '.venv', 'bin', 'python'),
      ['cli.py', photoPath, '--project', '--kind', kind], { cwd: REPO, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => fail(500, `cli spawn failed: ${e.message}`));
    child.on('close', (code) => {
      if (code !== 0) {
        return fail(code === 2 ? 400 : 500, `cli exit ${code}: ${err.slice(-500)}`);
      }
      let plan;
      try {
        plan = JSON.parse(out);
      } catch {
        return fail(500, 'cli projection is not JSON');
      }
      if (!plan || plan.mode !== 'projection' ||
          !Number.isFinite(plan.projected_sam_calls) ||
          !Number.isFinite(plan.projected_spark_crops)) {
        return fail(500, 'cli projection shape invalid');
      }
      resolve(plan);
    });
  });
}

function runCloseup(photoPath, { dryRun, focus, hardness }) {
  return new Promise((resolve, reject) => {
    const fail = (status, message) => reject(Object.assign(new Error(message), { status }));
    const args = ['cli.py', photoPath, '--closeup'];
    if (dryRun) args.push('--dry-run');
    if (focus) args.push('--focus', focus);
    if (hardness) args.push('--hardness', hardness);
    const env = { ...process.env };
    if (dryRun) {
      delete env.MODEL_API_KEY; // dry runs make zero calls; fail-safe
    } else if (!env.MODEL_API_KEY) {
      return fail(503, 'MODEL_API_KEY not set on proxy; live scans unavailable');
    }
    const child = spawn(path.join(REPO, '.venv', 'bin', 'python'), args, { cwd: REPO, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => fail(500, `cli spawn failed: ${e.message}`));
    child.on('close', (code) => {
      if (code !== 0) {
        return fail(code === 2 ? 400 : 500, `cli exit ${code}: ${err.slice(-500)}`);
      }
      const assessment = extractAssessment(out);
      if (assessment && assessment.mode === 'closeup_assessment' &&
          assessment.stone && Array.isArray(assessment.suggestions)) {
        return resolve(assessment);
      }
      console.error(`closeup stdout unparseable (${out.length} chars, dry=${!!dryRun}); `
        + `head: ${JSON.stringify(out.slice(0, 500))}; stderr tail: ${JSON.stringify(err.slice(-1500))}`);
      if (dryRun) {
        return fail(500, 'Dry close-up produced no readable assessment.');
      }
      const mined = mineCloseupErr(err);
      runCloseup(photoPath, { dryRun: true, focus, hardness }).then((dry) => {
        console.error(`closeup served dry fallback (mined ${
          mined && mined.sent !== null ? `${mined.sent} images sent` : 'no count'})`);
        resolve(assembleFallback(dry, mined));
      }, (dryErr) => {
        fail(500, `${fallbackParseError(mined)} Local fallback also failed: ${dryErr.message}`);
      });
    });
  });
}

// $0 pre-flight spend projection for one photo. Takes the same photo the
// live scan would take; returns counts plus a cost range, never a key,
// a report, or live-scan bytes.
app.post('/project', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'attach a photo as multipart field "photo"' });
    }
    const kind = req.query.kind || 'bed';
    if (kind !== 'bed' && kind !== 'closeup') {
      return res.status(400).json({ error: `unknown kind ${JSON.stringify(kind)}` });
    }
    const plan = await runProjection(req.file.path, kind);
    const cost = costRange(plan.projected_sam_calls, plan.projected_spark_crops);
    res.json({
      projection: true,
      kind,
      photo: { width: plan.width, height: plan.height },
      scales: plan.scales,
      phases: plan.phases,
      region: plan.region,
      top_n: plan.top_n,
      projected_sam_calls: plan.projected_sam_calls,
      max_sam_calls: plan.max_sam_calls,
      sam_cap_hit: plan.sam_cap_hit,
      projected_spark_crops: plan.projected_spark_crops,
      top_n_cap_hit: plan.top_n_cap_hit,
      projected_images_sent: plan.projected_images_sent,
      cost_usd: { min: cost.min, max: cost.max },
      images_sent: 0,
      models: [],
    });
  } catch (e) {
    console.error(`POST /project failed: ${String((e && e.message) || e)}`);
    res.status(e.status || 500).json({ error: String((e && e.message) || e) });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

// Single-stone close-up assessment. Fields: photo (image, required),
// focus "X,Y" raw pixels (optional), hardness JSON (optional). Modes live
// (default, needs key) and dry ($0, no key).
app.post('/closeup', upload.single('photo'), async (req, res) => {
  const mode = req.query.mode || 'live';
  try {
    if (!['live', 'dry'].includes(mode)) {
      return res.status(400).json({ error: `unknown mode ${JSON.stringify(mode)}` });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'attach a photo as multipart field "photo"' });
    }
    const focus = req.body && req.body.focus ? String(req.body.focus) : null;
    if (focus !== null && !/^\d+,\d+$/.test(focus)) {
      return res.status(400).json({ error: 'focus must be raw pixel coords as "X,Y"' });
    }
    const hardness = req.body && req.body.hardness ? String(req.body.hardness) : null;
    if (hardness !== null) {
      let parsed;
      try {
        parsed = JSON.parse(hardness);
      } catch {
        return res.status(400).json({ error: 'hardness must be a JSON object' });
      }
      if (!parsed || typeof parsed !== 'object' || !('cleaned' in parsed) ||
          !Array.isArray(parsed.tests) || !('range' in parsed)) {
        return res.status(400).json({ error: 'hardness needs {cleaned, tests, range}' });
      }
    }
    const assessment = await runCloseup(req.file.path,
      { dryRun: mode === 'dry', focus, hardness });
    res.type('json').send(JSON.stringify(assessment));
  } catch (e) {
    console.error(`POST /closeup failed: ${String((e && e.message) || e)}`);
    res.status(e.status || 500).json({ error: String((e && e.message) || e) });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

app.post('/scan', upload.single('photo'), async (req, res) => {
  const mode = req.query.mode || 'live';
  try {
    if (!['live', 'dry', 'stub'].includes(mode)) {
      return res.status(400).json({ error: `unknown mode ${JSON.stringify(mode)}` });
    }
    if (mode === 'stub') {
      try {
        const data = await fs.promises.readFile(BANKED_REPORT, 'utf8');
        JSON.parse(data);
        return res.type('json').send(data);
      } catch {
        return res.status(503).json({ error: 'banked report unavailable' });
      }
    }
    if (!req.file) {
      return res.status(400).json({ error: 'attach a photo as multipart field "photo"' });
    }
    const report = await runCli(req.file.path, { dryRun: mode === 'dry' });
    res.type('json').send(report);
  } catch (e) {
    res.status(e.status || 500).json({ error: String((e && e.message) || e) });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(400).json({ error: String((err && err.message) || err) });
});

if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST, { maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/scan') ||
        req.path.startsWith('/demo') || req.path.startsWith('/health') ||
        req.path.startsWith('/project') || req.path.startsWith('/closeup')) {
      return next();
    }
    res.sendFile(path.join(DIST, 'index.html'));
  });
} else {
  console.warn('PWA dist missing -- API only. Build web/pwa to serve the UI.');
}

app.listen(PORT, () => console.log(`gem proxy on :${PORT} (repo ${REPO})`));
