#!/usr/bin/env node
//
// viperclub.js — Playwright wrapper for the orchard-viper-forum
// agent. Four subcommands, each prints JSON to stdout and exits:
//
//   auth-check                           verify cookies still log in
//   search "<query>" [--limit N]         run a forum search
//   read-thread "<url>" [--max-posts N]  read a thread + posts
//   recent <forum-path> [--limit N]      list recent threads in a sub-forum
//
// Targets viperclub.org/vca/, which runs XENFORO (not vBulletin —
// verified against the live site on 2026-05-23). Cookies are loaded
// from /secrets/viperclub.cookies.json (read-only mount). The
// Cookie-Editor browser extension exports cookies in Playwright's
// addCookies() shape directly — see README.md for capture steps.
//
// Selectors live in the SELECTORS object below. When the forum
// changes templates (XenForo skin updates), updates land in one place.
// Each block is annotated with the verification date.

'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const fs = require('fs');

// ─── Config ────────────────────────────────────────────────────────────

const COOKIES_PATH = process.env.VIPER_COOKIES_PATH
  || '/secrets/viperclub.cookies.json';

const BASE = (process.env.VIPER_BASE_URL || 'https://www.viperclub.org/vca').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;

const DELAY_MS = Number(process.env.VIPER_DELAY_MS || 1500);

const USER_AGENT = process.env.VIPER_USER_AGENT
  || 'clawborrator-orchard-viper-forum/0.1 (+https://next.clawborrator.com)';

// XenForo selectors. Verified against viperclub.org/vca on
// 2026-05-23 with a logged-in session.
//
// SELECTORS LAST VERIFIED: 2026-05-23
const SELECTORS = {
  // Top-nav element that exists only when logged in. The username
  // is also reachable via `.p-navgroup-link--user .p-navgroup-link-text`
  // on most XenForo skins; we don't depend on the visible text because
  // some skins render it as an avatar only. Presence of the element
  // alone is the authoritative "logged in" signal.
  loggedInIndicator:  '.p-navgroup-link--user',
  loggedInUsername:   '.p-navgroup-link--user .p-navgroup-link-text',

  // Search form on /vca/search/. The form POSTs to /vca/search/search
  // and XenForo redirects to /vca/search/<id>/?q=... with results.
  searchKeywordInput: 'input[name="keywords"]',
  searchSubmit:       'form button[type="submit"], form button.button--primary',

  // Search results: each result is a li.block-row containing a
  // .contentRow. Title is the first anchor inside .contentRow-main.
  // Author is exposed as a data attribute on the li for cleanliness.
  searchResultRow:    'li.block-row',
  searchResultTitle:  '.contentRow-main h3 a, .contentRow-main a',
  searchResultSnippet:'.contentRow-snippet',
  searchResultTime:   '.contentRow-minor time, time',
  searchResultForum:  '.contentRow-minor a',  // first anchor is usually the forum link

  // Thread page (URL pattern: /vca/threads/<slug>.<id>/).
  threadTitle:        'h1.p-title-value',
  threadBreadcrumb:   '.p-breadcrumbs li:last-of-type a',
  postBlock:          'article.message',
  postUsername:       '.message-name .username, .message-name a',
  postTime:           'time',
  postContent:        '.message-body .bbWrapper, .bbWrapper',
  postNumberAttribution: '.message-attribution-opposite a',
  // XenForo wraps quoted replies in .bbCodeBlock--quote. Strip these
  // so the agent doesn't see N copies of an earlier post.
  postQuoteChrome:    '.bbCodeBlock--quote, .bbCodeBlock--quote *',

  // Pagination "next" link inside .pageNav.
  paginationNext:     'a.pageNav-jump--next, .pageNav-jump--next',

  // Sub-forum page (URL pattern: /vca/forums/<slug>.<id>/).
  forumThreadRow:     '.structItem--thread',
  forumThreadTitle:   '.structItem-title a',
  forumThreadTime:    'time',
};

// Numeric forum ids the operator can populate as they discover
// frequently-used sub-forums. If `recent <slug>` is called and the
// slug isn't in the alias table, the wrapper assumes the slug is the
// full XenForo path component (e.g. "general-viper-discussion.192").
const KNOWN_FORUMS = {
  // 'general':     'general-viper-discussion.192',
  // 'ask-hq':      'ask-vca-headquarters.256',
  // 'new-owner':   'new-owner-questions.160',
};

// ─── Helpers ───────────────────────────────────────────────────────────

function loadCookies() {
  if (!fs.existsSync(COOKIES_PATH)) {
    throw new Error(`cookies file not found at ${COOKIES_PATH}. ` +
      `Capture via the Cookie-Editor extension and mount the JSON file. ` +
      `See README.md for the full capture flow.`);
  }
  const raw = fs.readFileSync(COOKIES_PATH, 'utf8');
  const cookies = JSON.parse(raw);
  return cookies.map((c) => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain,
    path:     c.path || '/',
    expires:  typeof c.expirationDate === 'number' ? c.expirationDate : undefined,
    httpOnly: !!c.httpOnly,
    secure:   !!c.secure,
    sameSite: normalizeSameSite(c.sameSite),
  }));
}

function normalizeSameSite(s) {
  if (!s) return 'Lax';
  const v = String(s).toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'none')   return 'None';
  return 'Lax';
}

async function browserContext() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const ctx = await browser.newContext({
    userAgent: USER_AGENT,
    locale:    'en-US',
    viewport:  { width: 1280, height: 800 },
  });
  await ctx.addCookies(loadCookies());
  return { browser, ctx };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function err(msg, code = 1) {
  process.stderr.write(`viperclub.js: ${msg}\n`);
  process.exit(code);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[k] = next;
        i++;
      } else {
        args[k] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function absUrl(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  if (href.startsWith('/'))    return ORIGIN + href;
  return `${BASE}/${href}`;
}

// ─── Subcommands ───────────────────────────────────────────────────────

async function authCheck() {
  const { browser, ctx } = await browserContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const indicator = await page.$(SELECTORS.loggedInIndicator);
    if (!indicator) {
      out({ logged_in: false, reason: 'logged-in indicator not present; cookies likely expired' });
      return;
    }
    let username = null;
    const u = await page.$(SELECTORS.loggedInUsername);
    if (u) username = (await u.textContent() || '').trim() || null;
    out({ logged_in: true, username });
  } finally {
    await browser.close();
  }
}

async function search(query, limit) {
  if (!query) err('search requires a query string');
  const { browser, ctx } = await browserContext();
  try {
    const page = await ctx.newPage();
    // Visit the search index, fill the form, submit. XenForo will
    // redirect us to /search/<id>/?q=... where the results render.
    await page.goto(`${BASE}/search/`, { waitUntil: 'domcontentloaded' });
    await page.fill(SELECTORS.searchKeywordInput, query);
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.click(SELECTORS.searchSubmit),
    ]);
    await sleep(DELAY_MS);

    const rows = await page.$$(SELECTORS.searchResultRow);
    const results = [];
    for (const row of rows) {
      if (results.length >= limit) break;
      const author = (await row.getAttribute('data-author')) || null;
      const titleEl = await row.$(SELECTORS.searchResultTitle);
      if (!titleEl) continue;
      const title = ((await titleEl.textContent()) || '').trim();
      const url   = absUrl(await titleEl.getAttribute('href'));
      if (!title || !url) continue;
      const snippetEl = await row.$(SELECTORS.searchResultSnippet);
      const snippet   = snippetEl ? ((await snippetEl.textContent()) || '').replace(/\s+/g, ' ').trim() : null;
      const timeEl    = await row.$(SELECTORS.searchResultTime);
      const posted_at = timeEl
        ? (await timeEl.getAttribute('datetime')) || (await timeEl.textContent() || '').trim() || null
        : null;
      const forumEl   = await row.$(SELECTORS.searchResultForum);
      const forum     = forumEl ? ((await forumEl.textContent()) || '').trim() || null : null;
      results.push({ title, url, author, posted_at, forum, snippet });
    }
    out({ query, count: results.length, results });
  } finally {
    await browser.close();
  }
}

async function readThread(url, maxPosts) {
  if (!url) err('read-thread requires a thread URL');
  const { browser, ctx } = await browserContext();
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(DELAY_MS);

    const titleEl = await page.$(SELECTORS.threadTitle);
    const title = titleEl ? ((await titleEl.textContent()) || '').replace(/\s+/g, ' ').trim() : null;
    const crumbEl = await page.$(SELECTORS.threadBreadcrumb);
    const forum = crumbEl ? ((await crumbEl.textContent()) || '').trim() : null;

    const posts = [];
    let safetyPages = 0;
    while (posts.length < maxPosts && safetyPages < 50) {
      const blocks = await page.$$(SELECTORS.postBlock);
      for (const b of blocks) {
        if (posts.length >= maxPosts) break;
        const author      = (await b.getAttribute('data-author')) || null;
        const userEl      = await b.$(SELECTORS.postUsername);
        const username    = userEl ? ((await userEl.textContent()) || '').trim() : author;
        const timeEl      = await b.$(SELECTORS.postTime);
        const posted_at   = timeEl
          ? (await timeEl.getAttribute('datetime')) || (await timeEl.textContent() || '').trim() || null
          : null;
        const postNumEl   = await b.$(SELECTORS.postNumberAttribution);
        const post_number = postNumEl ? ((await postNumEl.textContent()) || '').trim() : null;
        const contentEl   = await b.$(SELECTORS.postContent);
        const content     = contentEl ? await extractPostText(contentEl) : '';
        posts.push({ author: username || author, posted_at, post_number, content });
      }
      if (posts.length >= maxPosts) break;
      const nextLink = await page.$(SELECTORS.paginationNext);
      if (!nextLink) break;
      const nextHref = absUrl(await nextLink.getAttribute('href'));
      if (!nextHref) break;
      await sleep(DELAY_MS);
      await page.goto(nextHref, { waitUntil: 'domcontentloaded' });
      safetyPages++;
    }
    out({ url, title, forum, posts });
  } finally {
    await browser.close();
  }
}

async function recent(slugOrPath, limit) {
  if (!slugOrPath) err('recent requires a forum slug or path (e.g. "general-viper-discussion.192")');
  const { browser, ctx } = await browserContext();
  try {
    const page = await ctx.newPage();
    const path = KNOWN_FORUMS[slugOrPath] || slugOrPath;
    const url = path.startsWith('http') ? path : `${BASE}/forums/${path}/`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(DELAY_MS);

    const rows = await page.$$(SELECTORS.forumThreadRow);
    const results = [];
    for (const row of rows) {
      if (results.length >= limit) break;
      const author  = (await row.getAttribute('data-author')) || null;
      const titleEl = await row.$(SELECTORS.forumThreadTitle);
      if (!titleEl) continue;
      const title = ((await titleEl.textContent()) || '').trim();
      const href  = absUrl(await titleEl.getAttribute('href'));
      if (!title || !href) continue;
      const timeEl = await row.$(SELECTORS.forumThreadTime);
      const posted_at = timeEl
        ? (await timeEl.getAttribute('datetime')) || (await timeEl.textContent() || '').trim() || null
        : null;
      results.push({ title, url: href, author, posted_at, forum: slugOrPath, snippet: null });
    }
    out({ forum: slugOrPath, count: results.length, results });
  } finally {
    await browser.close();
  }
}

// Extract clean post body text, dropping XenForo quoted-reply chrome
// so the agent doesn't get N copies of the same earlier post.
async function extractPostText(contentEl) {
  return await contentEl.evaluate((el) => {
    const clone = el.cloneNode(true);
    for (const q of clone.querySelectorAll('.bbCodeBlock--quote, .bbCodeBlock--quote *, blockquote')) {
      // Remove the whole quote container, not just children, so the
      // attribution line ("Bob said:") doesn't survive.
      const top = q.closest('.bbCodeBlock--quote');
      (top || q).remove();
    }
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  });
}

// ─── Entry point ───────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd) err('usage: viperclub.js {auth-check|search|read-thread|recent} [...]');

  try {
    switch (cmd) {
      case 'auth-check':
        await authCheck();
        break;
      case 'search': {
        const query = args._[1];
        const limit = Number(args.limit || 10);
        await search(query, limit);
        break;
      }
      case 'read-thread': {
        const url = args._[1];
        const maxPosts = Number(args['max-posts'] || 20);
        await readThread(url, maxPosts);
        break;
      }
      case 'recent': {
        const slug = args._[1];
        const limit = Number(args.limit || 20);
        await recent(slug, limit);
        break;
      }
      default:
        err(`unknown subcommand: ${cmd}`);
    }
  } catch (e) {
    err(`${e.message}${e.stack ? '\n' + e.stack : ''}`, 1);
  }
}

main();
