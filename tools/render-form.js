/**
 * render-form.js — gas/index.html をデプロイせずに手元で確認するためのツール
 * 2026-09-16 作成 / 2026-09-25 共通部分を gas-sandbox.js へ移動
 * 関連：gas/index.html／gas/main.gs（buildViewModel_）／tools/gas-sandbox.js
 *
 * HtmlService のテンプレート構文は素のブラウザでは動かない。そこで
 * buildViewModel_() 相当の値を流し込み、普通の HTML にして書き出す。
 * デプロイの代わりにはならない。見た目と分岐の確認用。
 *
 * 実行： node tools/render-form.js [出力先.html]
 *        node tools/render-form.js --empty [出力先.html]   受付可能日ゼロの表示
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sandbox = require('./gas-sandbox.js');

const args = process.argv.slice(2);
const wantEmpty = args.indexOf('--empty') !== -1;
const outPath = args.filter((a) => a !== '--empty')[0] ||
  path.join(__dirname, '..', 'preview-form.html');

const context = sandbox.buildContext(wantEmpty ? [] : sandbox.sampleAvailability());
const result = sandbox.renderForm(context);

fs.writeFileSync(outPath, result.html);
console.log('書き出しました： ' + outPath);
console.log('  受付可能日 ' + Object.keys(result.model.availability.days).length + '日分' +
  (wantEmpty ? '（--empty のため候補ゼロ）' : ''));
