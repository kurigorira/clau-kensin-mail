/**
 * render-form.js — gas/index.html をデプロイせずに手元で確認するためのツール
 * 2026-09-16 作成。関連：gas/index.html／gas/main.gs（buildViewModel_）
 *
 * HtmlService のテンプレート構文（<? ?> <?= ?> <?!= ?>）は素のブラウザでは動かない。
 * そこで buildViewModel_() 相当の値を作って流し込み、普通の HTML にして書き出す。
 * 画面の見た目や分岐を確かめたいときに使う。デプロイの代わりにはならない。
 *
 * 実行： node tools/render-form.js [出力先.html]
 *        node tools/render-form.js --empty [出力先.html]   受付可能日ゼロの表示を確認する
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAS_DIR = path.join(__dirname, '..', 'gas');
const LOAD_ORDER = ['config.gs', 'sheet.gs', 'form.gs', 'mail.gs', 'notify.gs', 'main.gs'];

/** HtmlService のテンプレートと同じ書き方を、ここで解釈する。 */
function renderTemplate(source, model) {
  let body = "var __out = '';\n";
  let rest = source;

  while (rest.length) {
    const start = rest.indexOf('<?');
    if (start === -1) {
      body += '__out += ' + JSON.stringify(rest) + ';\n';
      break;
    }
    body += '__out += ' + JSON.stringify(rest.slice(0, start)) + ';\n';
    rest = rest.slice(start);

    const end = rest.indexOf('?>');
    if (end === -1) throw new Error('テンプレートの <? が閉じられていません');
    let tag = rest.slice(2, end);
    rest = rest.slice(end + 2);

    if (tag[0] === '!' && tag[1] === '=') {
      body += '__out += (' + tag.slice(2) + ');\n';          // エスケープなし
    } else if (tag[0] === '=') {
      body += '__out += __esc(' + tag.slice(1) + ');\n';      // エスケープあり
    } else {
      body += tag + '\n';                                     // スクリプトレット
    }
  }
  body += 'return __out;';

  const escape = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // eslint-disable-next-line no-new-func
  return new Function('model', '__esc', body)(model, escape);
}

/** GAS の API を、buildViewModel_() が動く最小限だけ用意する。 */
function buildContext(availableDays) {
  const availRows = availableDays.map(([date, am, pm, memo]) => [
    date, am, pm, '', memo || '', new Date(), 'preview@example.jp'
  ]);
  const sheets = {
    '予約依頼台帳': { rows: [] },
    '受付可能日': { rows: [['日付', '午前', '午後', '対象コース', 'メモ', '最終更新', '更新者'], ...availRows] }
  };

  function fakeSheet(store, name) {
    return {
      getName: () => name,
      getLastRow: () => store.rows.length,
      getLastColumn: () => store.rows.reduce((m, r) => Math.max(m, r.length), 0),
      getRange: (top, left, height, width) => ({
        getValues() {
          const out = [];
          for (let r = 0; r < height; r++) {
            const row = store.rows[top - 1 + r] || [];
            const line = [];
            for (let c = 0; c < width; c++) line.push(row[left - 1 + c] === undefined ? '' : row[left - 1 + c]);
            out.push(line);
          }
          return out;
        }
      })
    };
  }

  const context = {
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (name) => (sheets[name] ? fakeSheet(sheets[name], name) : null)
      })
    },
    Utilities: {
      formatDate(date, _tz, format) {
        const p = (n) => String(n).padStart(2, '0');
        return format
          .replace('yyyy', date.getFullYear()).replace('MM', p(date.getMonth() + 1))
          .replace('dd', p(date.getDate())).replace('HH', p(date.getHours()))
          .replace('mm', p(date.getMinutes())).replace('ss', p(date.getSeconds()));
      }
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/PREVIEW/exec' }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    MailApp: { sendEmail: () => {} },
    HtmlService: { createHtmlOutput: (html) => ({ html, addMetaTag() { return this; } }) },
    DriveApp: { createFile: () => ({ getUrl: () => '' }) },
    MimeType: { CSV: 'text/csv' },
    Session: { getActiveUser: () => ({ getEmail: () => '' }) },
    Logger: { log: () => {} },
    console: { log: () => {}, warn: () => {}, error: (m) => process.stderr.write(String(m) + '\n') },
    JSON, Math, Date, String, Number, Object, Array, isNaN, parseInt, RegExp, Error
  };
  context.globalThis = context;
  vm.createContext(context);

  for (const file of LOAD_ORDER) {
    vm.runInContext(fs.readFileSync(path.join(GAS_DIR, file), 'utf8'), context, { filename: file });
  }
  vm.runInContext("SPREADSHEET_ID = 'PREVIEW';", context);
  return context;
}

// ===== 実行 =====

const args = process.argv.slice(2);
const wantEmpty = args.indexOf('--empty') !== -1;
const outPath = args.filter((a) => a !== '--empty')[0] ||
  path.join(__dirname, '..', 'preview-form.html');

function dateAfter(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// 実運用に近い形で、2週間先まで平日に候補を置く
const days = [];
if (!wantEmpty) {
  for (let i = 3; i <= 24; i++) {
    const d = dateAfter(i);
    const w = d.getDay();
    if (w === 0) continue;                       // 日曜は休み
    days.push([d, '◯', w === 6 ? '' : '◯', '']); // 土曜は午前のみ
  }
}

const context = buildContext(days);
const model = vm.runInContext('buildViewModel_()', context);
const template = fs.readFileSync(path.join(GAS_DIR, 'index.html'), 'utf8');

fs.writeFileSync(outPath, renderTemplate(template, model));
console.log('書き出しました： ' + outPath);
console.log('  受付可能日 ' + Object.keys(model.availability.days).length + '日分' +
  (wantEmpty ? '（--empty のため候補ゼロ）' : ''));
