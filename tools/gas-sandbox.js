/**
 * gas-sandbox.js — GAS の API をスタブして .gs を手元で動かすための土台
 * 2026-09-25 作成。関連：tools/render-form.js／tools/render-screens.js
 *
 * GAS はこの環境で実行できないので、SpreadsheetApp などを偽物に差し替えて
 * gas/*.gs を読み込む。画面の書き出しに使う。
 *
 * 依存は増やさない方針なので、Node の標準機能だけで書いてある。
 * 送信処理そのものの検証は tools/local-test.js が持っている（こちらは画面用）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAS_DIR = path.join(__dirname, '..', 'gas');
const LOAD_ORDER = ['config.gs', 'sheet.gs', 'form.gs', 'mail.gs', 'notify.gs', 'main.gs'];

/** HtmlService のテンプレート（<? ?> <?= ?> <?!= ?>）を、ここで解釈する。 */
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
    const tag = rest.slice(2, end);
    rest = rest.slice(end + 2);

    if (tag[0] === '!' && tag[1] === '=') {
      body += '__out += (' + tag.slice(2) + ');\n';       // エスケープなし
    } else if (tag[0] === '=') {
      body += '__out += __esc(' + tag.slice(1) + ');\n';   // エスケープあり
    } else {
      body += tag + '\n';                                  // スクリプトレット
    }
  }
  body += 'return __out;';

  const escape = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // eslint-disable-next-line no-new-func
  return new Function('model', '__esc', body)(model, escape);
}

/** 受付可能日シートの中身を模した行を作る。平日に候補を置く。 */
function sampleAvailability(dayCount) {
  const rows = [];
  for (let i = 3; i <= (dayCount || 24); i++) {
    const base = new Date();
    base.setDate(base.getDate() + i);
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const weekday = day.getDay();
    if (weekday === 0) continue;                                  // 日曜は休み
    rows.push([day, '◯', weekday === 6 ? '' : '◯', '', '', new Date(), 'sample@example.jp']);
  }
  return rows;
}

/**
 * gas/*.gs を読み込んだ実行コンテキストを返す。
 * availabilityRows を空にすると「受付可能日ゼロ」の状態を再現できる。
 */
function buildContext(availabilityRows) {
  const sheets = {
    '予約依頼台帳': { rows: [] },
    '受付可能日': {
      rows: [['日付', '午前', '午後', '対象コース', 'メモ', '最終更新', '更新者'],
             ...(availabilityRows || [])]
    }
  };

  function fakeSheet(store, name) {
    return {
      getName: () => name,
      getLastRow: () => store.rows.length,
      getLastColumn: () => store.rows.reduce((max, row) => Math.max(max, row.length), 0),
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
      openById: () => ({ getSheetByName: (name) => (sheets[name] ? fakeSheet(sheets[name], name) : null) })
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
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/SAMPLE/exec' }) },
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
  vm.runInContext("SPREADSHEET_ID = 'SAMPLE';", context);
  return context;
}

/** 実行コンテキストの中で式を評価する。画面生成関数の呼び出しに使う。 */
function evaluate(context, expression) {
  return vm.runInContext(expression, context);
}

/** index.html をレンダリングして普通の HTML にする。 */
function renderForm(context) {
  const model = evaluate(context, 'buildViewModel_()');
  const template = fs.readFileSync(path.join(GAS_DIR, 'index.html'), 'utf8');
  return { html: renderTemplate(template, model), model };
}

module.exports = { buildContext, evaluate, renderForm, renderTemplate, sampleAvailability, GAS_DIR };
