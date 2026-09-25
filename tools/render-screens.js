/**
 * render-screens.js — 申込画面だけでなく、完了・エラー・受付停止まで全画面を書き出す
 * 2026-09-25 作成。関連：gas/main.gs（各画面の生成関数）／tools/gas-sandbox.js
 *
 * 受付担当に見てもらう画面サンプルを作るために使う。
 * デプロイしなくても「どんなときにどの画面が出るか」を確認できる。
 *
 * 実行： node tools/render-screens.js [出力先ディレクトリ]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sandbox = require('./gas-sandbox.js');

const outDir = process.argv[2] || path.join(__dirname, '..', 'preview-screens');
fs.mkdirSync(outDir, { recursive: true });

const context = sandbox.buildContext(sandbox.sampleAvailability());
const emptyContext = sandbox.buildContext([]);

// 確認画面（JavaScript 無効時）に渡す、送信されてきた値の例。
// 実在の受診者データは使わない（CLAUDE.md 厳守事項）。
const samplePost = {
  kubun: '健康保険組合の補助を利用',
  extra_kenpo: '○○健康保険組合',
  extra_hojoken: 'あり',
  course: 'スタンダード（1日）',
  options: ['胃カメラ', 'マンモグラフィー'],
  chinsei: '希望する',
  name: '見本 花子',
  kana: 'ミホン ハナコ',
  birth: '1979-05-12',
  sex: '女性',
  tel: '090-0000-0000',
  mail: 'sample@example.com',
  jikan: '夕方以降',
  rireki: '初めて',
  wish1: '2026-10-14|午前',
  wish2: '2026-10-15|午後',
  wish3: '2026-10-17|午前',
  safety_ninshin: '該当なし',
  safety_kessen: 'わからない',
  safety_kaijo: '不要',
  safety_netsu: '該当なし',
  biko: '鎮静剤を使った場合、当日の車の運転はできますか。'
};

const screens = [
  {
    file: '01-input.html', title: '入力画面',
    when: '申込者がリンクから最初に開く画面',
    html: () => sandbox.renderForm(context).html
  },
  {
    file: '02-confirm-noscript.html', title: '確認画面（JavaScript 無効の場合）',
    when: 'JavaScript を切っている環境で「入力内容を確認する」を押したとき',
    html: () => sandbox.evaluate(context, 'renderConfirm_')(samplePost).html
  },
  {
    file: '03-done.html', title: '完了画面',
    when: '送信が成功し、台帳に1行入ったとき',
    html: () => sandbox.evaluate(context, 'renderDone_')('20260925-0001').html
  },
  {
    file: '04-error-input.html', title: '入力エラー画面',
    when: 'サーバ側の検証で足りない項目が見つかったとき',
    html: () => sandbox.evaluate(context, 'renderError_')(
      ['お名前をご入力ください。', '電話番号は数字とハイフンでご入力ください。'], false).html
  },
  {
    file: '05-error-slot.html', title: '受付終了のご案内',
    when: 'ページを開いたまま放置し、その間に希望日の受付が終了していたとき',
    html: () => sandbox.evaluate(context, 'renderError_')(
      ['選択された日は受付が終了しました。お手数ですが選び直してください。（2026-10-14 午前）'], true).html
  },
  {
    file: '06-failure.html', title: '送信失敗画面',
    when: '台帳へ書き込めなかったとき。受け付けた顔をせず電話番号を出す',
    html: () => sandbox.evaluate(context, 'renderFailure_')().html
  },
  {
    file: '07-suspended.html', title: '受付停止中',
    when: 'config.gs の IS_SUSPENDED を true にしたとき（年末年始など）',
    html: () => sandbox.evaluate(context, 'renderSuspended_')().html
  },
  {
    file: '08-no-availability.html', title: '受付可能日がゼロのとき',
    when: '受付可能日シートに◯が1つも無いとき。空のカレンダーは出さない',
    html: () => sandbox.renderForm(emptyContext).html
  }
];

const index = [];
for (const screen of screens) {
  const html = screen.html();
  fs.writeFileSync(path.join(outDir, screen.file), html);
  index.push({ file: screen.file, title: screen.title, when: screen.when, bytes: html.length });
  console.log('  ' + screen.file + '  ' + screen.title);
}
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));

console.log('\n' + screens.length + '画面を書き出しました： ' + outDir);
