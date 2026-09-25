#!/usr/bin/env node
/* ==========================================================================
   Regenerates the portfolio screenshots:
     screenshots/<app>.png         1440×900 hero shot (README)
     screenshots/<app>-2.png       1440×900 second feature shot (app README)
     screenshots/thumbs/<app>.jpg  800×500 thumbnail (portfolio hub page)
     screenshots/portfolio-hub.png the hub page itself

   Each app exposes a small window.<App> hook that this script uses to put it
   into a representative state before capturing.

   Requires Playwright with Chromium:
     npm i -D playwright && npx playwright install chromium
     node tools/screenshots.js [app-name-filter …]
   ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.normalize(path.join(ROOT, p));
      if (!file.startsWith(ROOT)) {
        res.writeHead(403);
        return res.end();
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const wait = (page, ms) => page.waitForTimeout(ms);
const idle = async (page, flag) => {
  for (let k = 0; k < 300; k++) {
    await wait(page, 100);
    if (!(await page.evaluate(flag))) break;
  }
  await wait(page, 300);
};

/** One entry per app: open it, stage the hero shot, then an optional second shot. */
const APPS = [
  {
    slug: 'pid-motor-lab',
    url: 'mechatronics/pid-motor-lab/index.html',
    async hero(page) {
      // capture three step responses: aggressive and sluggish pinned, balanced live
      await page.evaluate(() => MotorLab.setGains({ kp: 80, ki: 40, kd: 1.5 }));
      await wait(page, 6500);
      await page.evaluate(() => { MotorLab.pin(); MotorLab.setGains({ kp: 10, ki: 0, kd: 3 }); });
      await wait(page, 5200);
      await page.evaluate(() => { MotorLab.pin(); MotorLab.setGains({ kp: 120, ki: 400, kd: 7 }); MotorLab.setTab('terms'); });
      await wait(page, 5200);
    },
    async second(page) {
      await page.evaluate(() => MotorLab.setTab('bode'));
      await wait(page, 500);
    },
  },
  {
    slug: 'robot-arm-studio',
    url: 'mechatronics/robot-arm-studio/index.html',
    async hero(page) {
      await wait(page, 2600);
    },
    async second(page) {
      await page.evaluate(() => {
        ArmStudio.setMode('draw');
        const pts = [];
        for (let k = 0; k <= 400; k++) {
          const t = (k / 400) * 2 * Math.PI;
          pts.push([0.55 * Math.sin(t), 1.25 + 0.3 * Math.sin(2 * t)]);
        }
        ArmStudio.draw(pts);
      });
      await wait(page, 9000);
    },
  },
  {
    slug: 'ct-reconstruction-lab',
    url: 'medical-imaging/ct-reconstruction-lab/index.html',
    async hero(page) {
      await wait(page, 1500);
      await page.evaluate(() => TomoLab.set({ views: 30, method: 'sarttv', iters: 20 }));
      await idle(page, () => TomoLab.busy);
    },
    async second(page) {
      await page.evaluate(() => TomoLab.set({ phantom: 'hip', views: 180, method: 'fbp' }));
      await idle(page, () => TomoLab.busy);
    },
  },
  {
    slug: 'mri-kspace-explorer',
    url: 'medical-imaging/mri-kspace-explorer/index.html',
    async hero(page) {
      await idle(page, () => KSpace.busy);
      await page.evaluate(() => KSpace.mask('random', 0.3));
      await idle(page, () => KSpace.busy);
    },
    async second(page) {
      await page.evaluate(() => { KSpace.mask('full'); KSpace.preset('flair'); KSpace.toggle('tg-spike', true); KSpace.toggle('tg-motion', true); KSpace.phys('bars'); });
      await idle(page, () => KSpace.busy);
    },
  },
  {
    slug: 'smart-wheelchair-navigator',
    url: 'assistive-robotics/smart-wheelchair-navigator/index.html',
    async hero(page) {
      await wait(page, 9000);
    },
    async second(page) {
      await page.evaluate(() => { NaviChair.toggle('tg-slam', true); NaviChair.setRobot(1.3, 4.5, 0); NaviChair.goTo('desk'); });
      await wait(page, 10000);
    },
  },
  {
    slug: 'emg-prosthetic-hand',
    url: 'assistive-robotics/emg-prosthetic-hand/index.html',
    async hero(page) {
      await wait(page, 500);
      await page.evaluate(() => MyoHand.setIntent(1));
      await wait(page, 1500);
    },
    async second(page) {
      await page.evaluate(() => { MyoHand.setIntent(3); MyoHand.tab('confusion'); });
      await wait(page, 1500);
    },
  },
  {
    slug: 'neural-network-playground',
    url: 'ai/neural-network-playground/index.html',
    async hero(page) {
      await wait(page, 5000);
    },
    async second(page) {
      await page.evaluate(() => NeuroPlayground.preset('vanish'));
      await wait(page, 5000);
    },
  },
  {
    slug: 'neuroevolution-cars',
    url: 'ai/neuroevolution-cars/index.html',
    async hero(page) {
      await wait(page, 1000);
      await page.evaluate(() => EvoDrive.fastForward(16));
      await wait(page, 5000);
    },
    async second(page) {
      await page.evaluate(() => {
        EvoDrive.fastForward(12);
        EvoDrive.newTrack();
        document.querySelector('#seg-rays button[data-value="all"]').click();
      });
      await wait(page, 4000);
    },
  },
  {
    slug: 'agentflow',
    url: 'agentic-research/agentflow/index.html',
    async hero(page) {
      await wait(page, 1200);
      await page.evaluate(() => AgentFlow.finishReplay());
      await wait(page, 400);
    },
    async second(page) {
      await page.evaluate(() => { AgentFlow.preset('coding'); AgentFlow.finishReplay(); AgentFlow.pin(); AgentFlow.set({ retries: 0, timeout: 30 }); AgentFlow.tab('bottleneck'); });
      await wait(page, 600);
      await page.evaluate(() => AgentFlow.finishReplay());
      await wait(page, 3000);
    },
  },
  {
    slug: 'metalab',
    url: 'agentic-research/metalab/index.html',
    async hero(page) {
      await wait(page, 800);
    },
    async second(page) {
      await page.evaluate(() => MetaLab.module('bias'));
      await wait(page, 300);
      await page.evaluate(() => MetaLab.bias('hacked'));
      await wait(page, 4800);
    },
    async third(page) {
      await page.evaluate(() => { MetaLab.module('power'); });
      await wait(page, 400);
      await page.evaluate(() => MetaLab.simulate());
      await wait(page, 600);
    },
  },
];

async function thumbnail(browser, png, jpg) {
  const page = await browser.newPage();
  const src = 'data:image/png;base64,' + fs.readFileSync(png).toString('base64');
  const data = await page.evaluate(async (s) => {
    const img = new Image();
    img.src = s;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 500;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.86);
  }, src);
  fs.writeFileSync(jpg, Buffer.from(data.split(',')[1], 'base64'));
  await page.close();
}

(async () => {
  const filters = process.argv.slice(2);
  fs.mkdirSync(path.join(OUT, 'thumbs'), { recursive: true });
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  let failed = false;
  for (const app of APPS) {
    if (filters.length && !filters.some((f) => app.slug.includes(f))) continue;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const t0 = Date.now();
    await page.goto(base + app.url, { waitUntil: 'load' });
    await app.hero(page);
    const hero = path.join(OUT, `${app.slug}.png`);
    await page.screenshot({ path: hero });
    if (app.second) {
      await app.second(page);
      await page.screenshot({ path: path.join(OUT, `${app.slug}-2.png`) });
    }
    if (app.third) {
      await app.third(page);
      await page.screenshot({ path: path.join(OUT, `${app.slug}-3.png`) });
    }
    await thumbnail(browser, hero, path.join(OUT, 'thumbs', `${app.slug}.jpg`));
    console.log(`${errors.length ? '✗' : '✓'} ${app.slug} (${((Date.now() - t0) / 1000).toFixed(1)} s)${errors.length ? '\n    ' + errors.join('\n    ') : ''}`);
    failed = failed || errors.length > 0;
    await page.close();
  }
  if (!filters.length || filters.some((f) => 'portfolio-hub'.includes(f))) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(base + 'index.html', { waitUntil: 'networkidle' });
    await wait(page, 500);
    await page.screenshot({ path: path.join(OUT, 'portfolio-hub.png') });
    console.log('✓ portfolio-hub');
    await page.close();
  }
  await browser.close();
  srv.close();
  process.exit(failed ? 1 : 0);
})();
