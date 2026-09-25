/**
 * shoot-screens.js — 画面サンプル用のスクリーンショットを撮る
 * 2026-09-25 作成。関連：tools/render-screens.js／docs/kensin-form-screens.html
 *
 * 【このツールだけ playwright が要る。プロジェクトの依存にはしない】
 * 「依存を増やさない」（CLAUDE.md）は本体の話で、撮影は年に数回の作業。
 * リポジトリには入れず、使うときだけ別の場所に入れて NODE_PATH で渡す。
 *
 *   mkdir -p ~/pw && cd ~/pw && npm i playwright
 *   cd <このリポジトリ>
 *   node tools/render-screens.js
 *   NODE_PATH=~/pw/node_modules node tools/shoot-screens.js
 *
 * 撮った PNG は docs/screens/ に入り、docs/kensin-form-screens.html が読む。
 * gas/index.html や config.gs を直したら、撮り直して両方コミットすること。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const SCREENS = path.join(ROOT, 'preview-screens');     // render-screens.js の出力
const OUT = path.join(ROOT, 'docs', 'screens');
// 手元の Chromium。環境変数で差し替えられるようにしておく
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const WIDTH = 760;        // 実物の本文幅（640px）＋ 余白
const SCALE = 1.5;        // 文字が読める程度。2 にするとファイルが倍近くになる

if (!fs.existsSync(path.join(SCREENS, '01-input.html'))) {
  console.error('先に node tools/render-screens.js を実行してください。');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  // 画面外は撮れないので、ページ全体が収まる高さのビューポートにしておく
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: 12000 },
    deviceScaleFactor: SCALE
  });

  /** startSel の上端から endSel の上端までを切り出す（endSel 省略でページ末尾まで）。 */
  async function clipShot(name, startSel, endSel) {
    const pad = 14;
    const box = await page.evaluate(function (sel) {
      var a = document.querySelector(sel[0]);
      var top = a.getBoundingClientRect().top + window.scrollY;
      var bottom = sel[1]
        ? document.querySelector(sel[1]).getBoundingClientRect().top + window.scrollY
        : document.documentElement.scrollHeight;
      var wrap = document.querySelector('.wrap') || document.body;
      var rw = wrap.getBoundingClientRect();
      return { x: Math.max(0, rw.left - 16), w: Math.min(window.innerWidth, rw.width + 32), top: top, bottom: bottom };
    }, [startSel, endSel || null]);

    await page.screenshot({
      path: path.join(OUT, name + '.png'),
      clip: { x: box.x, y: Math.max(0, box.top - pad), width: box.w, height: box.bottom - box.top + pad * 2 }
    });
    console.log('  ' + name + '.png');
  }

  // ---------- 入力画面 ----------
  await page.goto('file://' + path.join(SCREENS, '01-input.html'));
  // 節の見出しを目印にするため、h2 に連番の id を振る（撮影用。実物には無い）
  await page.evaluate(function () {
    var list = document.querySelectorAll('h2');
    for (var i = 0; i < list.length; i++) list[i].id = 'h2-' + i;
  });

  await clipShot('s01-top', 'h1', '#h2-1');
  await clipShot('s02-course', '#h2-1', '#h2-2');
  await clipShot('s03-options', '#h2-2', '#h2-3');

  // 分岐の3枚は、検査一覧の先頭から撮ると肝心の案内が下に埋もれる。
  // 胃カメラの行から下だけを切り出す。
  await page.evaluate(function () {
    document.querySelector('input[name="options"][value="\u80c3\u30ab\u30e1\u30e9"]')
      .closest('label').id = 'anchor-endo';
  });

  // 分岐：胃カメラ → 鎮静剤と絶食の案内
  await page.check('input[name="options"][value="胃カメラ"]');
  await page.check('input[name="chinsei"][value="希望する"]');
  await clipShot('s04-endo', '#anchor-endo', '#h2-3');

  // 分岐：大腸カメラ（別日）とマンモグラフィー（曜日限定）
  await page.check('input[name="options"][value="大腸カメラ"]');
  await page.check('input[name="options"][value="マンモグラフィー"]');
  await clipShot('s05-colon', '#anchor-endo', '#h2-3');

  // 排他：胃透視を選ぶと胃カメラが外れ、鎮静剤の欄も消える
  await page.check('input[name="options"][value="胃透視"]');
  await clipShot('s06-stomach-exclusive', '#anchor-endo', '#h2-3');
  await page.check('input[name="options"][value="胃カメラ"]');
  await page.check('input[name="chinsei"][value="希望する"]');
  await page.check('input[name="options"][value="頭部MR"]');

  // 区分とコースを埋めて、以降の節を撮る
  await page.check('input[name="kubun"][value="健康保険組合の補助を利用"]');
  await page.fill('#extra_kenpo', '○○健康保険組合');
  await page.selectOption('#extra_hojoken', 'あり');
  await page.check('input[name="course"][value="スタンダード（1日）"]');
  await clipShot('s07-personal', '#h2-3', '#h2-4');

  // 希望日。カレンダーで3つ選ぶ
  for (var n = 0; n < 3; n++) {
    const days = await page.$$('#cal-grid button:not([disabled])');
    if (!days[n]) break;
    await days[n].click();
    const slot = await page.$('#slot-pick button');
    if (slot) await slot.click();
  }
  await clipShot('s08-calendar', '#h2-4', '#h2-5');

  // 安全のための確認（女性・MR・胃カメラを選んだ状態で出る項目）
  await page.check('input[name="sex"][value="女性"]');
  await clipShot('s09-safety', '#h2-5', '#h2-6');

  // 入力もれ。画面内でとめて、上にまとめて出す
  await page.click('#btn-confirm');
  await page.waitForTimeout(300);
  await clipShot('s10-error-inline', 'h1', '#h2-1');

  // ---------- 入力画面以外（1枚もの） ----------
  const others = [
    ['s11-confirm-noscript', '02-confirm-noscript.html'],
    ['s12-done', '03-done.html'],
    ['s13-error-input', '04-error-input.html'],
    ['s14-error-slot', '05-error-slot.html'],
    ['s15-failure', '06-failure.html'],
    ['s16-suspended', '07-suspended.html'],
    ['s17-no-availability', '08-no-availability.html']
  ];
  for (var i = 0; i < others.length; i++) {
    // clip はビューポートの外を撮れないので、十分に高いビューポートで開く
    const p = await browser.newPage({ viewport: { width: WIDTH, height: 2400 }, deviceScaleFactor: SCALE });
    await p.goto('file://' + path.join(SCREENS, others[i][1]));
    // fullPage はビューポートの高さを下回らないので、中身の高さで切る
    // documentElement.scrollHeight はビューポートの高さを下回らないので使えない。
    // body の下端で切る。
    const h = await p.evaluate(function () {
      return Math.ceil(document.body.getBoundingClientRect().bottom + window.scrollY) + 16;
    });
    await p.screenshot({
      path: path.join(OUT, others[i][0] + '.png'),
      clip: { x: 0, y: 0, width: WIDTH, height: h }
    });
    await p.close();
    console.log('  ' + others[i][0] + '.png');
  }

  // ---------- スマートフォン幅 ----------
  const phone = await browser.newPage({ viewport: { width: 375, height: 1500 }, deviceScaleFactor: SCALE });
  await phone.goto('file://' + path.join(SCREENS, '01-input.html'));
  const overflows = await phone.evaluate(function () {
    return document.documentElement.scrollWidth > window.innerWidth + 1;
  });
  await phone.screenshot({
    path: path.join(OUT, 's18-phone.png'),
    clip: { x: 0, y: 0, width: 375, height: 1400 }
  });
  console.log('  s18-phone.png');
  console.log('幅375px の横スクロール： ' + (overflows ? 'あり（要修正）' : 'なし'));

  await browser.close();
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
