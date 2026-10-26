#!/usr/bin/env node
/* Dependency-free site-wide checks: pages, local links, fragments, IDs. */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredPages = ['index.html', 'scheduling.html', 'runtime.html', 'model.html', 'sampling.html', 'performance.html', 'atlas.html'];
const requiredNav = requiredPages;
const requiredAssets = ['assets/site.css', 'assets/site.js', 'assets/navigation.css', 'assets/favicon.svg'];
const checkpoints = [];
const failures = [];

function check(name, ok, detail = '') {
  checkpoints.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? ': ' + detail : ''}`);
}

function scanTags(html) {
  const tags = [];
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 1);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    const end = html.indexOf('>', lt + 1);
    if (end < 0) break;
    const tag = html.slice(lt, end + 1);
    const nameMatch = tag.match(/^<\s*\/?\s*([a-zA-Z][\w:-]*)/);
    const name = nameMatch ? nameMatch[1].toLowerCase() : '';
    tags.push({ raw: tag, name });
    i = end + 1;
    if (['script', 'style', 'pre', 'code', 'textarea'].includes(name) && !/^<\s*\//.test(tag)) {
      const close = lower.indexOf(`</${name}`, i);
      i = close < 0 ? html.length : close;
    }
  }
  return tags;
}

function attrsOf(raw) {
  const attrs = [];
  for (const m of raw.matchAll(/(?:^|\s)([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs.push([m[1].toLowerCase(), m[2] ?? m[3] ?? '']);
  }
  return attrs;
}

function idsOf(html) {
  return scanTags(html).flatMap(({ raw }) => attrsOf(raw).filter(([k]) => k === 'id').map(([, v]) => v));
}

const files = readdirSync(root).filter(name => name.endsWith('.html') && statSync(resolve(root, name)).isFile()).sort();
const docs = new Map(files.map(name => [name, readFileSync(resolve(root, name), 'utf8')]));

for (const asset of requiredAssets) check(`asset ${asset}`, existsSync(resolve(root, asset)));
check('reduced-motion CSS present', readFileSync(resolve(root, 'assets/site.css'), 'utf8').includes('prefers-reduced-motion'));
check('index.html is present', docs.has('index.html'));

const staleCopy = /待展开|后续批次|仅首页|待续|本阶段已展开|已在本页覆盖|深读待|先划线|当前检查点/g;
const allHtml = [...docs.values()].join('\n');
const stale = [...new Set(allHtml.match(staleCopy) || [])];
check('no stale navigation/status copy', stale.length === 0, stale.join(', '));
check('no disabled placeholder navigation', !/unit-turn__disabled|nav-pending/.test(allHtml));
check('no local absolute paths', !/\/Users\/[A-Za-z0-9_.-]+\//.test(allHtml));

for (const [name, html] of docs) {
  const tags = scanTags(html);
  const tagAttrs = tags.map(({ raw }) => attrsOf(raw));
  const ids = idsOf(html);
  const idSet = new Set(ids);
  const duplicateIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

  check(`${name}: lang is zh-CN`, /<html[^>]+lang="zh-CN"/.test(html));
  check(`${name}: viewport meta present`, /name="viewport"/.test(html));
  const hasScript = /<script\b/i.test(html);
  check(`${name}: no-JS fallback when scripted`, !hasScript || /<noscript>/i.test(html), hasScript && !/<noscript>/i.test(html) ? 'script page lacks <noscript>' : '');
  check(`${name}: skip link present`, /class="skip-link"/.test(html));
  check(`${name}: fixed commit is used`, html.includes('553741557a57df44a46fb3ab72b6aafeaf945337'));
  check(`${name}: no unpinned main source links`, !/github\.com\/deepseek-ai\/DeepInfer\/(blob|tree)\/main\b/.test(html));

  check(`${name}: duplicate IDs`, duplicateIds.length === 0, duplicateIds.join(', '));

  const navMatch = html.match(/<nav class="primary-nav"[\s\S]*?<\/nav>/);
  check(`${name}: unified primary nav present`, Boolean(navMatch));
  if (navMatch) {
    const navHrefs = [...navMatch[0].matchAll(/href="([^"]+)"/g)].map(m => m[1]);
    const missingNav = requiredNav.filter(href => !navHrefs.includes(href));
    check(`${name}: primary nav links all seven pages`, missingNav.length === 0, missingNav.join(', '));
  }
  check(`${name}: navigation stylesheet loaded`, /href="assets\/navigation\.css"/.test(html));

  const refProblems = [];
  const fragmentProblems = [];
  let localRefs = 0;
  for (const attrs of tagAttrs) {
    for (const [key, rawValue] of attrs) {
      if (key !== 'href' && key !== 'src') continue;
      const value = rawValue.replaceAll('&amp;', '&');
      if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) continue;
      if (value.startsWith('/')) {
        refProblems.push(`${value} (absolute path)`);
        continue;
      }
      localRefs += 1;
      const hashIndex = value.indexOf('#');
      const fragment = hashIndex < 0 ? '' : decodeURIComponent(value.slice(hashIndex + 1));
      let pathPart = hashIndex < 0 ? value : value.slice(0, hashIndex);
      const queryIndex = pathPart.indexOf('?');
      if (queryIndex >= 0) pathPart = pathPart.slice(0, queryIndex);
      if (!pathPart) {
        if (fragment && !idSet.has(fragment)) fragmentProblems.push(`#${fragment}`);
        continue;
      }
      const target = resolve(root, dirname(name), decodeURIComponent(pathPart));
      if (!existsSync(target)) {
        refProblems.push(value);
        continue;
      }
      if (!statSync(target).isFile()) {
        refProblems.push(`${value} (not a file)`);
        continue;
      }
      if (fragment) {
        const targetName = relative(root, target);
        const targetHtml = docs.get(targetName);
        if (targetHtml && !new Set(idsOf(targetHtml)).has(fragment)) fragmentProblems.push(`${targetName}#${fragment}`);
      }
    }
  }
  check(`${name}: local href/src targets (${localRefs})`, refProblems.length === 0, refProblems.slice(0, 6).join(', '));
  check(`${name}: local fragments resolve`, fragmentProblems.length === 0, fragmentProblems.slice(0, 6).join(', '));

  const blankTargets = tags
    .filter(({ raw, name: tagName }) => tagName === 'a' && /\btarget\s*=\s*"_blank"/.test(raw))
    .map(({ raw }) => raw);
  const badBlank = blankTargets.filter(raw => !/\brel\s*=\s*"[^"]*noopener/.test(raw));
  check(`${name}: new-tab links use noopener`, badBlank.length === 0, badBlank.slice(0, 3).join(' | '));

  const sourceLinks = tags
    .filter(({ raw }) => /\bclass\s*=\s*"[^"]*\bsrcline\b/.test(raw))
    .flatMap(({ raw }) => attrsOf(raw).filter(([k]) => k === 'href').map(([, v]) => v));
  check(`${name}: source links are HTTPS`, sourceLinks.every(href => /^https:\/\//.test(href)), sourceLinks.filter(href => !/^https:\/\//.test(href)).join(', '));
}

const missingPages = requiredPages.filter(name => !docs.has(name));
check('all seven pages present', missingPages.length === 0, missingPages.join(', '));

for (const { name, ok, detail } of checkpoints) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
console.log(`\n${checkpoints.filter(c => c.ok).length}/${checkpoints.length} checks passed across ${docs.size} HTML files.`);
if (failures.length) {
  console.error('\nFailures:\n- ' + failures.join('\n- '));
  process.exit(1);
}
