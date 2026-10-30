// 高校邦 本地刷课台 —— 127.0.0.1:18800
// 多账号：每次登录开一个全新浏览器会话，不共用 cookie，不在磁盘留登录态
// 只监听本机；不持久化密码；仅处理 Video 章节 + 视频内练习测验
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = 18800;

let browser = null;
let ctx = null;
let page = null;
let base = '';          // 例如 https://xmut.gaoxiaobang.com
let keepAwake = null;

const st = {
  running: false,
  queue: [],
  idx: -1,
  current: null,
  log: [],
  needsUser: null,
  last: null,
  timer: null,
  quizKey: null,
  endedAt: 0,
  noVideoAt: 0,
  busy: false,
};

const HOME = () => base + '/#/user/user_home';

function log(msg, extra) {
  const line = `${new Date().toLocaleTimeString('zh-CN')} ${msg}` + (extra ? ' ' + JSON.stringify(extra) : '');
  st.log.push(line);
  if (st.log.length > 300) st.log.shift();
}

function normHost(s) {
  let h = String(s || '').trim().toLowerCase();
  h = h.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./, '');
  // 常见误输入：逗号、中文逗号/句号/顿号/全角点，被当成了点
  h = h.replace(/[，,、。｡．]/g, '.').replace(/\s+/g, '');
  h = h.replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '');
  if (!h || !h.includes('.')) {
    throw new Error('学校网址填错了，应该是类似 xmut.gaoxiaobang.com 这种');
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) {
    throw new Error('学校网址里有不认识的字符：' + h + '，应该是类似 xmut.gaoxiaobang.com 这种');
  }
  return h;
}

async function closeBrowser() {
  try { if (browser) await browser.close(); } catch (e) {}
  browser = null; ctx = null; page = null;
}

async function newBrowser() {
  await closeBrowser();
  browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled', '--no-first-run'],
  });
  ctx = await browser.newContext({ viewport: null, locale: 'zh-CN' });
  await ctx.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  });
  page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  return page;
}

async function ensureBrowser() {
  if (browser && page && !page.isClosed()) return;
  if (!base) throw new Error('还没登录');
  throw new Error('浏览器窗口被关掉了，请重新登录');
}

async function bringFront() {
  try { await page.bringToFront(); } catch (e) {}
}

/* ---------------- login ---------------- */
async function openSchool(host) {
  base = 'https://' + host;
  await newBrowser();
  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    const why = String(e.message || '').split('\n')[0];
    throw new Error('打不开 ' + base + '：' + why + '。请检查学校网址是不是写错了（不要用逗号代替点）。');
  }
  return page;
}

async function doLogin(school, user, pass) {
  const host = normHost(school);
  await openSchool(host);

  let hasForm = true;
  try {
    await page.waitForSelector('#username', { timeout: 22000 });
  } catch (e) {
    hasForm = false;
  }
  if (!hasForm) {
    // 没跳到登录页：可能已经是登录态，或者是无效域名
    const t = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160));
    throw new Error('这个网址没有出现登录页，检查一下域名是不是填对了。页面显示：' + t);
  }

  await page.fill('#username', user);
  await page.fill('#password', pass);
  const clicked = await page.click('.login_btn', { timeout: 8000 }).then(() => true).catch(() => false);
  if (!clicked) await page.press('#password', 'Enter');

  // 轮询判断结果：跳走=evaluate 上下文销毁；.autoTip=被拒；验证码=需要人工
  const probe = async (ms) => {
    try {
      return await page.evaluate(async (limit) => {
        const t0 = Date.now();
        while (Date.now() - t0 < limit) {
          const box = document.querySelector('.autoTip');
          if (box && getComputedStyle(box).display !== 'none') {
            const m = box.querySelector('.message');
            const txt = ((m ? m.innerText : box.innerText) || '').replace(/\s+/g, ' ').trim();
            return txt ? 'tip|' + txt.slice(0, 300) : 'tip|';
          }
          const cap = document.querySelector(
            'iframe[src*="captcha"], .nc-container, .verify-wrap, .nc_scale, [class*="slider"], [id*="captcha"]'
          );
          if (cap && cap.getBoundingClientRect().height > 10) return 'captcha|';
          await new Promise((r) => setTimeout(r, 300));
        }
        return 'timeout|';
      }, ms);
    } catch (e) {
      return 'nav|';
    }
  };

  // 四种提交姿势依次尝试。第一种用 JS 直接触发按钮：绕过透明遮罩和可见性判定，
  // 这个站的登录按钮之前就是被 Playwright 的“可点击性检查”卡住的。
  const jsClicked = await page
    .evaluate(() => {
      const b = document.querySelector('.login_btn');
      if (!b) return false;
      b.click();
      return true;
    })
    .catch(() => false);

  let out = await probe(9000);

  if (out.startsWith('timeout')) {
    await page.press('#password', 'Enter').catch(() => {});
    out = await probe(9000);
  }
  if (out.startsWith('timeout')) {
    await page.click('.login_btn', { timeout: 5000 }).catch(() => {});
    out = await probe(9000);
  }
  if (out.startsWith('timeout')) {
    await page.evaluate(() => {
      const f = document.querySelector('#login-form');
      if (f) f.submit();
    }).catch(() => {});
    out = await probe(9000);
  }

  if (!out.startsWith('nav')) {
    const kind = out.split('|')[0];
    const msg = out.slice(kind.length + 1);
    await page.evaluate(() => {
      const t = document.querySelector('.autoTip');
      if (!t) return;
      const btn = [...t.querySelectorAll('a,button,i,span,div')].find((e) =>
        /^(确定|关闭|Χ|×)$/.test((e.textContent || '').trim())
      );
      if (btn) btn.click();
    }).catch(() => {});

    const hint = '（登录窗口我留着了，账号密码已经填好：你可以直接在窗口里点「登录」或完成验证，然后回到网页点「刷新课程列表」。）';
    if (kind === 'captcha') throw new Error('需要完成人机验证。' + hint);
    if (msg) throw new Error('登录被拒绝：' + msg + hint);
    throw new Error('点了登录但页面没反应（按钮可能被遮挡）。' + hint);
  }

  const url = page.url();

  try { base = new URL(url).origin; } catch (e) {}
  log('登录成功', { school: host, user });
  return { url, base };
}

async function manualLogin(school) {
  const host = normHost(school);
  await openSchool(host);
  await bringFront();
  return page.url();
}

// 页面跳回学校站点后，把 base 校正成学校域名（不能停在 cas，也不能停在 class 子域）
function syncBase() {
  try {
    const u = new URL(page.url());
    if (/gaoxiaobang\.com$/.test(u.host) && !/^cas\./.test(u.host) && !/\.class\./.test(u.host)) base = u.origin;
  } catch (e) {}
}

// 课程页在 <学校>.class.gaoxiaobang.com，和首页不是同一个域名
function classBase() {
  try {
    const u = new URL(base);
    if (/\.class\./.test(u.host)) return u.origin;
    return u.protocol + '//' + u.host.replace(/\.gaoxiaobang\.com$/i, '.class.gaoxiaobang.com');
  } catch (e) {}
  return base;
}

/* ---------------- courses ---------------- */
async function waitCards() {
  await page.goto(HOME(), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.myhome_Course', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function listCourses() {
  await ensureBrowser();
  syncBase();
  if (/cas\.gaoxiaobang\.com/.test(page.url())) throw new Error('还没登录，请先在窗口里完成登录');
  await waitCards();
  return page.evaluate(() => {
    const rank = { 继续学习: 0, 开始学习: 1, 查看: 2 };
    const map = new Map();
    document.querySelectorAll('.myhome_Course').forEach((c) => {
      const btns = [...c.querySelectorAll('.myhome_Course_btn')].map((b) => (b.textContent || '').trim());
      const action = Object.keys(rank).find((t) => btns.includes(t));
      if (!action) return;
      let lines = (c.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      while (lines.length && lines[0] === '退课') lines.shift();
      const title = lines[0] || '';
      if (!title) return;
      const prog = lines.find((l) => /学习进度|学习成绩|成绩计算中/.test(l)) || '';
      const prev = map.get(title);
      if (!prev || rank[action] < rank[prev.action]) map.set(title, { title, action, progress: prog });
    });
    return [...map.values()];
  });
}

/* ---------------- chapters ---------------- */
async function openCourse(index) {
  await ensureBrowser();
  await waitCards();
  const before = ctx.pages().length;
  const ok = await page.evaluate((i) => {
    const cards = [...document.querySelectorAll('.myhome_Course')].filter((c) => {
      const btns = [...c.querySelectorAll('.myhome_Course_btn')].map((b) => (b.textContent || '').trim());
      return btns.some((t) => ['继续学习', '开始学习', '查看'].includes(t));
    });
    const card = cards[i];
    if (!card) return false;
    const btns = [...card.querySelectorAll('.myhome_Course_btn')];
    const b = ['继续学习', '开始学习', '查看']
      .map((t) => btns.find((x) => (x.textContent || '').trim() === t))
      .find(Boolean);
    if (!b) return false;
    b.click();
    return true;
  }, index);
  if (!ok) throw new Error('没点到这门课');
  await page.waitForTimeout(5000);
  if (ctx.pages().length > before) {
    const pages = ctx.pages();
    page = pages[pages.length - 1];
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);
  }
  const m = page.url().match(/\/class\/(\d+)\//);
  if (!m) throw new Error('进课程失败：' + page.url());
  return m[1];
}

async function listChapters(classId) {
  await page.goto(`${classBase()}/class/${classId}/unit`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a.chapter-info', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('a.chapter-info')].map((a) => {
      const unitEl = a.closest('.unit-list[data-unit-id]');
      const unitTitle = unitEl ? (unitEl.querySelector('.unit-title, h3, .unit-name') || {}).innerText || '' : '';
      return {
        title: a.getAttribute('title') || '',
        type: a.getAttribute('content_type') || '',
        chapter: a.getAttribute('chapter_id') || '',
        unit: unitEl ? unitEl.getAttribute('data-unit-id') : '',
        unitTitle: String(unitTitle).trim().slice(0, 40),
      };
    })
  );
  return items
    .filter((x) => x.chapter && x.unit)
    .map((x) => ({ ...x, url: `${classBase()}/class/${classId}/unit/${x.unit}/chapter/${x.chapter}` }));
}

async function listVideos(classId) {
  const all = await listChapters(classId);
  return all.filter((x) => x.type === 'Video').map((x) => ({ title: x.title, url: x.url }));
}

function pickTopics(all) {
  const topics = all.filter((x) => /^topic$/i.test(x.type));
  if (topics.length) return topics;
  // 兜底：按标题认
  return all.filter((x) => /讨论/.test(x.title) && x.type !== 'Video');
}

/* ---------------- 模型 ---------------- */
const LLM_CFG = (() => {
  // 1) 同目录的 llm.json  2) 环境变量  3) 作者本机的 DSH 凭据（别人机器上没有，不影响）
  const p = path.join(ROOT, 'llm.json');
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
  }
  const envKey = process.env.GXB_LLM_KEY || process.env.DEEPSEEK_API_KEY || '';
  if (envKey) {
    return {
      baseUrl: process.env.GXB_LLM_BASE || 'https://api.deepseek.com',
      model: process.env.GXB_LLM_MODEL || 'deepseek-chat',
      apiKey: envKey,
    };
  }
  try {
    const y = fs.readFileSync(path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml'), 'utf8');
    const m = y.match(/DEEPSEEK_API_KEY\s*:\s*(\S+)/);
    if (m) return { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: m[1] };
  } catch (e) {}
  return null;
})();

async function llm(prompt, maxTokens) {
  if (!LLM_CFG || !LLM_CFG.apiKey) throw new Error('没有可用的模型 API，请在 gxb/llm.json 里配置');
  const url = LLM_CFG.baseUrl.replace(/\/+$/, '') + (LLM_CFG.path || '/chat/completions');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LLM_CFG.apiKey },
    body: JSON.stringify({
      model: LLM_CFG.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.85,
      max_tokens: maxTokens || 1200,
    }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('模型调用失败(' + r.status + ')：' + txt.slice(0, 160));
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('模型返回不是 JSON：' + txt.slice(0, 120)); }
  const out = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
  return String(out || '').trim();
}

/* ---------------- keep awake ---------------- */
function startKeepAwake() {
  if (keepAwake) return;
  try {
    keepAwake = spawn(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'keepawake.ps1')],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    keepAwake.unref();
    log('已开启保持唤醒');
  } catch (e) { log('保持唤醒开启失败: ' + e.message); }
}
function stopKeepAwake() {
  if (!keepAwake) return;
  try { spawn('taskkill', ['/PID', String(keepAwake.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {}
  keepAwake = null;
  log('已关闭保持唤醒');
}

/* ---------------- watcher ---------------- */
async function readState() {
  return page.evaluate(() => {
    const v = document.querySelector('video');
    const q = document.querySelector('.gxb-video-quiz, [class*="video-quiz"]');
    const qv = !!(q && q.offsetParent !== null && (q.innerText || '').trim());
    return {
      url: location.href,
      hasVideo: !!v,
      t: v ? Math.round(v.currentTime) : null,
      dur: v ? Math.round(v.duration || 0) : null,
      pct: v && v.duration ? Math.round((v.currentTime / v.duration) * 100) : null,
      paused: v ? v.paused : null,
      ended: v ? v.ended : null,
      focused: document.hasFocus(),
      quiz: qv,
    };
  });
}

async function answerQuiz() {
  const info = await page.evaluate(() => {
    const c = document.querySelector('.gxb-video-quiz .correctAnswer');
    const t = document.querySelector('.gxb-video-quiz .quiz-type');
    return { correct: c ? c.getAttribute('data') : null, type: t ? t.innerText : null };
  });
  const letters = String(info.correct || '').split('').filter((ch) => 'ABCD'.includes(ch));
  if (!letters.length) {
    st.needsUser = { kind: 'quiz', at: Date.now(), url: page.url() };
    log('遇到读不到答案的题目，需要你处理');
    return;
  }
  for (const L of letters) {
    const idx = L.charCodeAt(0) - 65;
    await page.locator(`.gxb-video-quiz .answer-wap .answer >> nth=${idx}`).click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(180);
  }
  await page.waitForTimeout(260);
  await page.locator('.gxb-video-quiz .submit').click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1100);
  await page.locator('.gxb-video-quiz-footer .player').click({ timeout: 8000 }).catch(() => {});
  log('练习测验已作答', { type: info.type, answer: info.correct });
}

async function goNext() {
  st.idx += 1;
  if (st.idx >= st.queue.length) {
    st.running = false;
    st.current = null;
    if (st.timer) clearInterval(st.timer);
    st.timer = null;
    stopKeepAwake();
    log('全部视频刷完');
    return;
  }
  st.busy = true;
  try {
    st.current = st.queue[st.idx];
    st.quizKey = null;
    st.endedAt = 0;
    st.noVideoAt = 0;
    log('开始播放 ' + st.current.title);
    await page.goto(st.current.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(6000);
    await bringFront();
    // 视频可能还没 ready，重试几次（被自动播放策略拦下就静音再试）
    for (let i = 0; i < 6; i++) {
      const playing = await page
        .evaluate(() => {
          const v = document.querySelector('video');
          if (!v) return false;
          if (!v.paused) return true;
          v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
          return false;
        })
        .catch(() => false);
      if (playing) break;
      await page.waitForTimeout(1000);
    }
  } finally {
    st.busy = false;
  }
}

async function tick() {
  if (!st.running || !page || page.isClosed()) return;
  if (st.busy) return; // 正在切换视频，这期间的“没视频”不算数
  let s;
  try { s = await readState(); } catch (e) { return; }
  st.last = s;

  if (s.quiz) {
    const key = s.url + '#' + s.t;
    if (st.quizKey !== key) { st.quizKey = key; await answerQuiz(); }
    return;
  }

  if (!s.hasVideo) {
    if (!st.noVideoAt) st.noVideoAt = Date.now();
    if (st.current && Date.now() - st.noVideoAt > 8000) await goNext();
    return;
  }
  st.noVideoAt = 0;

  if (s.paused && !s.ended && s.focused) {
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v && v.paused) v.play().catch(() => {});
    }).catch(() => {});
  }

  if (s.ended || (s.dur && s.t >= s.dur - 2)) {
    if (!st.endedAt) st.endedAt = Date.now();
    if (Date.now() - st.endedAt > 6000) await goNext();
  } else {
    st.endedAt = 0;
  }
}

async function startQueue(index) {
  if (st.running) throw new Error('已经在刷了');
  await ensureBrowser();
  await page.goto(HOME(), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const course = (await listCourses())[index];
  const classId = await openCourse(index);
  const vids = await listVideos(classId);
  if (!vids.length) throw new Error('这门课里没有视频');
  st.queue = vids;
  st.idx = -1;
  st.running = true;
  st.log = [];
  st.needsUser = null;
  log(`课程「${course ? course.title : classId}」共 ${vids.length} 个视频`);
  startKeepAwake();
  if (st.timer) clearInterval(st.timer);
  st.timer = setInterval(() => tick().catch(() => {}), 5000);
  await goNext();
  return vids.map((v) => v.title);
}

/* ---------------- 专题讨论：生成草稿并填入，不提交 ---------------- */
function promptForTopic(q) {
  return [
    '你是一名中国大学生，正在完成《形势与政策》课程的专题讨论。',
    '老师给的题目：',
    q,
    '',
    '请直接写出可以提交的正文。要求：',
    '1. 400字左右，分3到4层意思；每层先用一句话点明观点，再用一两句展开。',
    '2. 语言朴实，像一个认真的大学生自己写的；不要堆砌“赋能/抓手/闭环”这类词。',
    '3. 不要复述题目，不要写“针对上述问题”“本文认为”。',
    '4. 不要出现 AI、机器人、助手之类的自称。',
    '5. 纯文本；不要 markdown、不要 # 号、不要加粗、不要项目符号。',
    '6. 可以适度结合学习生活，但不要编造具体人名和事件。',
    '只输出正文。',
  ].join('\n');
}

async function draftTopic(index, k) {
  await ensureBrowser();
  await page.goto(HOME(), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const course = (await listCourses())[index];
  const classId = await openCourse(index);
  const all = await listChapters(classId);
  const topics = pickTopics(all);
  if (!topics.length) throw new Error('这门课里没找到专题讨论');
  const t = topics[k];
  if (!t) throw new Error('没有第 ' + (k + 1) + ' 个讨论（共 ' + topics.length + ' 个）');

  await page.goto(t.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const q = await page.evaluate(() => {
    const el = document.querySelector('.topic-content') || document.querySelector('.topic-subject-container');
    return el ? el.innerText.replace(/[ \t]+\n/g, '\n').trim() : '';
  });
  if (!q) throw new Error('没读到讨论题目');
  log('生成草稿：' + t.title);

  const text = await llm(promptForTopic(q), 1100);

  // 打开回复框（点一次是展开编辑器，内容为空不会提交）
  await page.locator('i.post-submit').first().click({ timeout: 8000 }).catch(async () => {
    await page.evaluate(() => { const b = document.querySelector('i.post-submit'); if (b) b.click(); });
  });
  await page.waitForTimeout(1600);

  const html = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => '<p>' + s.replace(/[<>]/g, '') + '</p>')
    .join('');

  const ok = await page.evaluate((h) => {
    const ed = window.UE && window.UE.instants && window.UE.instants['ueditorInstant0'];
    if (!ed || !ed.body) return false;
    ed.body.innerHTML = h;
    try { ed.fireEvent('contentchange'); } catch (e) {}
    return true;
  }, html);
  if (!ok) throw new Error('没找到回复编辑器（页面结构可能变了）');

  log('草稿已填入回复框，等待你确认发布', { topic: t.title, chars: text.length });
  return { total: topics.length, k, question: q, text, title: t.title, course: course ? course.title : '' };
}

/* ---------------- 结课作业：生成正文 + 上传文件，不提交 ---------------- */
function promptForAssignment(q) {
  return [
    '你是一名中国大学生，正在完成《形势与政策》课程的结课作业。',
    '作业页面上的原文：',
    q,
    '',
    '请完成它。要求：',
    '1. 如果是二选一，自己挑一个题目明确写出来（在开头写清楚你选了哪个），然后作答。',
    '2. 正文不少于1000字。',
    '3. 结构清楚：先给观点，再分3到4层展开，最后收一句。每一层要有具体的分析，不要只有口号。',
    '4. 语言朴实、言之有物；可以举一般性的例子，但不要编造具体的人名、单位、数据和事件。',
    '5. 不要出现 AI、机器人、助手之类的自称，不要写“本文将”。',
    '6. 纯文本，不要 markdown、不要 # 号、不要加粗。',
    '只输出可以提交的正文。',
  ].join('\n');
}

async function readStudentInfo(classId) {
  try {
    return await page.evaluate(async (cid) => {
      const r = await fetch(`/transcript/class/${cid}/user/api`, { credentials: 'include' });
      const j = await r.json();
      return { name: j.studentName || '', no: j.studentNo || '' };
    }, classId);
  } catch (e) {
    return { name: '', no: '' };
  }
}

async function draftAssignment(index) {
  await ensureBrowser();
  await page.goto(HOME(), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const course = (await listCourses())[index];
  const classId = await openCourse(index);
  const all = await listChapters(classId);

  let asg = all.find((x) => /^assignment$/i.test(x.type));
  if (!asg) asg = all.find((x) => /作业/.test(x.title) && x.type !== 'Video');
  if (!asg) throw new Error('这门课里没找到结课作业');

  await page.goto(asg.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('a,button,span,div,i')].find(
      (e) => !e.children.length && (e.textContent || '').trim() === '开始作业' && e.offsetParent !== null
    );
    if (!el) return false;
    el.click();
    return true;
  });
  if (clicked) await page.waitForTimeout(5000);

  const q = await page.evaluate(() => {
    const b = document.body.innerText || '';
    const i = b.indexOf('问题');
    const t = i > -1 ? b.slice(i, i + 1800) : b.slice(0, 1800);
    return t.replace(/\n{3,}/g, '\n\n').trim();
  });
  if (!q || q.length < 30) throw new Error('没读到作业题目');

  const info = await readStudentInfo(classId);
  log('生成作业正文：' + (asg.title || '结课作业'));
  const text = await llm(promptForAssignment(q), 2600);

  const dir = path.join(ROOT, 'out');
  fs.mkdirSync(dir, { recursive: true });
  const safe = `${info.no || ''}${info.name || ''}-${asg.title || '结课作业'}`.replace(/[\\/:*?"<>|\s]/g, '_');
  const fp = path.join(dir, safe + '.txt');
  fs.writeFileSync(fp, text, 'utf8');

  const input = await page.$('input[type=file]');
  let uploaded = false;
  if (input) {
    await input.setInputFiles(fp);
    await page.waitForTimeout(3500);
    uploaded = true;
  }

  log(uploaded ? '作业文件已上传，等你确认提交' : '作业文件已生成，但没找到上传控件', { file: safe + '.txt' });
  return {
    question: q,
    text,
    file: fp,
    fileName: safe + '.txt',
    uploaded,
    student: info,
    course: course ? course.title : '',
    title: asg.title,
  };
}

/* ---------------- http ---------------- */
const PAGE = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/* ---------------- 排队 ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const q = {
  jobs: [],
  running: false,
  seq: 0,
};
const secrets = new Map(); // 只在内存里活到登录那一刻，之后立刻抹掉

function qPublic() {
  return {
    running: q.running,
    jobs: q.jobs.map((j) => ({
      id: j.id,
      user: j.user ? j.user.slice(0, 4) + '****' + j.user.slice(-2) : '',
      keyword: j.keyword,
      status: j.status,
      progress: j.progress || '',
      note: j.note || '',
      addedAt: j.addedAt,
    })),
  };
}

async function ensurePlay() {
  for (let k = 0; k < 5; k++) {
    const ok = await page
      .evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return false;
        if (!v.paused) return true;
        v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
        return false;
      })
      .catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(1200);
  }
  return false;
}

// 阻塞式：一条一条播完，返回实际完成条数
async function brushVideosBlocking(videos, job) {
  let done = 0;
  for (let i = 0; i < videos.length; i++) {
    if (!q.running) break;
    const v = videos[i];
    if (job) job.progress = `第 ${i + 1}/${videos.length} 条：${v.title}`;
    log(`[排队] 播放 ${v.title}`);

    await page.goto(v.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(6000);
    await bringFront().catch(() => {});
    await ensurePlay();

    const t0 = Date.now();
    let noVideoSince = 0;
    let endSince = 0;
    let watched = false;

    while (true) {
      if (!q.running) return done;
      const s = await readState().catch(() => null);
      if (!s) break;

      if (s.quiz) {
        await answerQuiz().catch(() => {});
        await page.waitForTimeout(1500);
        continue;
      }

      if (!s.hasVideo) {
        if (!noVideoSince) noVideoSince = Date.now();
        if (Date.now() - noVideoSince > 12000) break; // 这页确实没有视频，跳过
        await page.waitForTimeout(2500);
        continue;
      }
      noVideoSince = 0;

      if (s.paused && !s.ended) await ensurePlay();
      if (s.t > 20) watched = true;

      if (s.ended || (s.dur && s.t >= s.dur - 3)) {
        if (!endSince) endSince = Date.now();
        if (Date.now() - endSince > 5000) break;
      } else {
        endSince = 0;
      }

      // 超时保护：视频时长 + 20 分钟，或总共 3 小时
      if (s.dur && s.dur > 0 && Date.now() - t0 > (s.dur + 1200) * 1000) break;
      if (Date.now() - t0 > 3 * 3600 * 1000) break;

      await page.waitForTimeout(4000);
    }
    if (watched) done++;
  }
  return done;
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  job.progress = '登录中…';
  const pass = secrets.get(job.id) || '';
  try {
    await doLogin(job.school, job.user, pass);
    secrets.delete(job.id); // 登录成功立刻抹掉密码
    job.progress = '读取课程列表…';

    const courses = await listCourses();
    await sleep(1200);
    const kw = String(job.keyword || '').trim();
    const matched = [];
    for (let i = 0; i < courses.length; i++) {
      if (!kw || String(courses[i].title).includes(kw)) matched.push({ i, course: courses[i] });
    }
    if (!matched.length) throw new Error('没有标题含「' + kw + '」的课程');

    const summary = [];
    for (const { i, course } of matched) {
      if (!q.running) break;
      job.progress = '打开课程：' + course.title;
      await page.goto(HOME(), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2500);
      const classId = await openCourse(i);
      const vids = await listVideos(classId);
      if (!vids.length) {
        summary.push(course.title + '：没有视频');
        continue;
      }
      const n = await brushVideosBlocking(vids, job);
      summary.push(`${course.title}：刷完 ${n}/${vids.length}`);
    }

    job.status = 'done';
    job.progress = '';
    job.note = summary.join('；') || '没有可刷的内容';
  } catch (e) {
    secrets.delete(job.id);
    job.status = 'failed';
    job.progress = '';
    // 排队时没人会去点窗口，把那句“窗口留着了”的提示去掉
    job.note = String(e && e.message ? e.message : e).split('（登录窗口')[0].trim().slice(0, 200);
  } finally {
    secrets.delete(job.id);
    await closeBrowser().catch(() => {});
  }
}

async function queueLoop() {
  if (q.running) return;
  q.running = true;
  log('[排队] 开始处理队列');
  try {
    while (q.running) {
      const job = q.jobs.find((j) => j.status === 'waiting');
      if (!job) break;
      // 单次刷课正在用浏览器时，排队先等
      while (st.running && q.running) await sleep(3000);
      if (!q.running) break;
      await runJob(job);
      await sleep(2000);
    }
  } finally {
    q.running = false;
    log('[排队] 队列跑完');
  }
}

function queueAdd(school, user, pass, keyword) {
  const host = normHost(school);
  const u = String(user || '').trim();
  const p = String(pass || '');
  const kw = String(keyword || '').trim();
  if (!u || !p) throw new Error('学号和密码都要填');
  if (!kw) throw new Error('必须填课程关键词，比如：形势与政策');
  if (q.jobs.filter((j) => j.status === 'waiting' || j.status === 'running').length >= 30) {
    throw new Error('排队的人太多了，等一会儿再加');
  }
  const id = 'j' + ++q.seq + '_' + Date.now().toString(36);
  const job = {
    id,
    school: host,
    user: u,
    keyword: kw,
    status: 'waiting',
    progress: '',
    note: '',
    addedAt: Date.now(),
  };
  q.jobs.push(job);
  secrets.set(id, p);
  log('[排队] 加入：' + u + ' / ' + kw);
  if (!q.running) queueLoop().catch(() => {});
  return { id, ahead: Math.max(0, q.jobs.filter((j) => j.status === 'waiting').length - 1) };
}

/* ---------------- 访问口令（挂公网时必须） ---------------- */
const ACCESS_FILE = path.join(ROOT, 'access.json');
let ACCESS = '';
try { ACCESS = (JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8')) || {}).code || ''; } catch (e) {}
if (!ACCESS) {
  ACCESS = String(Math.floor(100000 + Math.random() * 900000));
  try { fs.writeFileSync(ACCESS_FILE, JSON.stringify({ code: ACCESS }, null, 2), 'utf8'); } catch (e) {}
}

function cookieOf(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function authed(req) {
  return cookieOf(req, 'gxb') === ACCESS;
}

const UNLOCK_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>需要访问口令</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif}
 .box{background:#fff;padding:32px 28px;border-radius:14px;box-shadow:0 8px 30px rgba(15,23,42,.08);width:320px}
 h1{font-size:17px;margin:0 0 6px;color:#0f172a}
 p{font-size:13px;color:#64748b;margin:0 0 18px;line-height:1.6}
 input{width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:15px;box-sizing:border-box;letter-spacing:2px}
 button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:9px;background:#2563eb;color:#fff;font-size:14.5px;cursor:pointer}
 button:disabled{background:#94a3b8}
 .err{color:#dc2626;font-size:13px;margin-top:10px;min-height:18px}
</style></head><body><div class="box">
<h1>需要访问口令</h1>
<p>这个页面能操作一台真实电脑上的浏览器，所以加了口令。向机主要 6 位数字。</p>
<input id="c" inputmode="numeric" maxlength="6" placeholder="6 位口令" autofocus>
<button id="b">进入</button>
<div class="err" id="e"></div>
</div><script>
async function go(){
  const c = document.getElementById('c').value.trim();
  const b = document.getElementById('b'), e = document.getElementById('e');
  if (c.length < 6) { e.textContent = '口令是 6 位数字'; return; }
  b.disabled = true; e.textContent = '';
  try {
    const r = await fetch('/api/unlock', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code: c }) });
    const j = await r.json();
    if (j.ok) location.reload(); else { e.textContent = j.error || '口令不对'; b.disabled = false; }
  } catch (err) { e.textContent = '连不上服务器'; b.disabled = false; }
}
document.getElementById('b').onclick = go;
document.getElementById('c').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (req.method === 'GET' && (u === '/' || u === '/index.html')) {
    if (!authed(req)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(UNLOCK_HTML);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let data = {};
    try { data = body ? JSON.parse(body) : {}; } catch (e) {}

    if (u === '/api/unlock') {
      if (String(data.code || '').trim() === ACCESS) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': 'gxb=' + encodeURIComponent(ACCESS) + '; Path=/; Max-Age=2592000; SameSite=Lax',
        });
        return res.end(JSON.stringify({ ok: true }));
      }
      return json(res, 401, { ok: false, error: '口令不对' });
    }
    if (!authed(req)) return json(res, 401, { ok: false, error: '需要访问口令' });

    try {
      if (u === '/api/login') {
        try {
          const r = await doLogin(data.school, data.user, data.pass);
          return json(res, 200, { ok: true, ...r });
        } catch (e) {
          log('登录失败：' + e.message);
          throw e;
        }
      }
      if (u === '/api/manual') {
        const url = await manualLogin(data.school);
        return json(res, 200, { ok: true, url, base });
      }
      if (u === '/api/logout') {
        st.running = false;
        if (st.timer) clearInterval(st.timer);
        st.timer = null;
        stopKeepAwake();
        await closeBrowser();
        base = '';
        return json(res, 200, { ok: true });
      }
      if (u === '/api/courses') {
        const list = await listCourses();
        return json(res, 200, { ok: true, courses: list, base });
      }
      if (u === '/api/assignment') {
        const r = await draftAssignment(Number(data.index || 0));
        return json(res, 200, { ok: true, ...r });
      }
      if (u === '/api/queue/add') {
        const r = queueAdd(data.school, data.user, data.pass, data.keyword);
        return json(res, 200, { ok: true, ...r });
      }
      if (u === '/api/queue') {
        return json(res, 200, { ok: true, ...qPublic() });
      }
      if (u === '/api/queue/remove') {
        const id = String(data.id || '');
        const j = q.jobs.find((x) => x.id === id);
        if (!j) throw new Error('没有这个任务');
        if (j.status === 'running') throw new Error('正在跑，不能取消');
        secrets.delete(id);
        q.jobs = q.jobs.filter((x) => x.id !== id);
        return json(res, 200, { ok: true });
      }
      if (u === '/api/queue/clear') {
        q.jobs = q.jobs.filter((j) => j.status === 'running');
        for (const k of [...secrets.keys()]) secrets.delete(k);
        return json(res, 200, { ok: true });
      }
      if (u === '/api/queue/stop') {
        q.running = false;
        return json(res, 200, { ok: true });
      }
      if (u === '/api/topics') {
        const r = await draftTopic(Number(data.index || 0), Number(data.k || 0));
        return json(res, 200, { ok: true, ...r });
      }
      if (u === '/api/start') {
        const titles = await startQueue(Number(data.index || 0));
        return json(res, 200, { ok: true, videos: titles });
      }
      if (u === '/api/stop') {
        st.running = false;
        if (st.timer) clearInterval(st.timer);
        st.timer = null;
        stopKeepAwake();
        try { await page.evaluate(() => { const v = document.querySelector('video'); if (v) v.pause(); }); } catch (e) {}
        log('已停止');
        return json(res, 200, { ok: true });
      }
      if (u === '/api/debug/text') {
        await ensureBrowser();
        const info = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          text: (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 3000),
        }));
        return json(res, 200, { ok: true, ...info });
      }
      if (u === '/api/debug/goto') {
        await ensureBrowser();
        await page.goto(String(data.url || HOME()), { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(Number(data.wait || 3000));
        return json(res, 200, { ok: true, url: page.url() });
      }
      if (u === '/api/debug/eval') {
        await ensureBrowser();
        const out = await page.evaluate(data.js || 'null');
        return json(res, 200, { ok: true, result: out });
      }
      if (u === '/api/status') {
        return json(res, 200, {
          ok: true,
          base,
          loggedIn: !!base,
          running: st.running,
          idx: st.idx,
          total: st.queue.length,
          current: st.current ? st.current.title : null,
          last: st.last,
          needsUser: st.needsUser,
          log: st.log.slice(-30),
        });
      }
      json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('ui: http://127.0.0.1:' + PORT);
  try {
    const os = require('os');
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) console.log('局域网: http://' + n.address + ':' + PORT);
      }
    }
  } catch (e) {}
  console.log('访问口令: ' + ACCESS);
});