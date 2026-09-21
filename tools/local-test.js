/**
 * local-test.js — GAS の API をスタブして、送信処理を手元で通すための検証用スクリプト
 * 2026-09-16 作成。関連：gas/*.gs
 *
 * GAS はこの環境で実行できないため、SpreadsheetApp などを偽物に差し替えて
 * doPost を端から端まで走らせる。台帳に入る値・メール本文・エラーの出方を
 * デプロイ前に確認するのが目的。
 *
 * 実行： node tools/local-test.js
 *
 * ※ gas/ の外に置いているのは、clasp で GAS へ push される対象に入れないため。
 *   このファイルは本番には含めない。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAS_DIR = path.join(__dirname, '..', 'gas');
const LOAD_ORDER = ['config.gs', 'sheet.gs', 'form.gs', 'mail.gs', 'notify.gs', 'main.gs'];

// ===== GAS API のスタブ ==============================================

/** 二次元配列を持つだけの偽シート。GAS の Sheet のうち、使っているメソッドだけ実装する。 */
class FakeSheet {
  constructor(name, rows) {
    this.name = name;
    this.rows = rows || [];    // [[...], [...]]
  }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() {
    return this.rows.reduce((max, row) => Math.max(max, row.length), 0);
  }
  getRange(top, left, height, width) {
    const sheet = this;
    height = height === undefined ? 1 : height;
    width = width === undefined ? 1 : width;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < height; r++) {
          const row = sheet.rows[top - 1 + r] || [];
          const line = [];
          for (let c = 0; c < width; c++) line.push(row[left - 1 + c] === undefined ? '' : row[left - 1 + c]);
          out.push(line);
        }
        return out;
      },
      setValues(values) {
        for (let r = 0; r < values.length; r++) {
          const target = top - 1 + r;
          if (!sheet.rows[target]) sheet.rows[target] = [];
          for (let c = 0; c < values[r].length; c++) sheet.rows[target][left - 1 + c] = values[r][c];
        }
        return this;
      },
      setValue(value) { return this.setValues([[value]]); }
    };
  }
  appendRow(row) { this.rows.push(row.slice()); }
  deleteRow(rowNumber) { this.rows.splice(rowNumber - 1, 1); }
  setFrozenRows() {}
  setFrozenColumns() {}
}

class FakeSpreadsheet {
  constructor(sheets) { this.sheets = sheets; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) { this.sheets[name] = new FakeSheet(name, []); return this.sheets[name]; }
}

const sentMails = [];
const logs = { info: [], warn: [], error: [] };

function pad(n, width) { return String(n).padStart(width, '0'); }

function buildContext(sheets) {
  const spreadsheet = new FakeSpreadsheet(sheets);

  const context = {
    // --- スプレッドシート ---
    SpreadsheetApp: { openById: () => spreadsheet },

    // --- 排他 ---
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    },

    // --- メール ---
    MailApp: { sendEmail: (options) => sentMails.push(options) },

    // --- 日付整形。使っている書式だけ実装する ---
    Utilities: {
      formatDate(date, _tz, format) {
        const y = date.getFullYear();
        const m = pad(date.getMonth() + 1, 2);
        const d = pad(date.getDate(), 2);
        const hh = pad(date.getHours(), 2);
        const mm = pad(date.getMinutes(), 2);
        const ss = pad(date.getSeconds(), 2);
        return format
          .replace('yyyy', y).replace('MM', m).replace('dd', d)
          .replace('HH', hh).replace('mm', mm).replace('ss', ss);
      }
    },

    // --- Web アプリ ---
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }),
      getProjectTriggers: () => [],
      newTrigger: () => ({
        timeBased: () => ({
          atHour: function () { return this; },
          everyDays: function () { return this; },
          onMonthDay: function () { return this; },
          create: () => {}
        })
      }),
      deleteTrigger: () => {}
    },

    HtmlService: {
      createHtmlOutput(html) {
        return { html, addMetaTag() { return this; }, getContent() { return this.html; } };
      }
    },

    DriveApp: {
      createFile: (name) => ({ getUrl: () => 'https://drive.example/' + name })
    },
    MimeType: { CSV: 'text/csv' },
    Session: { getActiveUser: () => ({ getEmail: () => 'test@example.jp' }) },

    Logger: { log: (m) => logs.info.push(String(m)) },
    console: {
      log: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
      error: (m) => logs.error.push(String(m))
    },

    JSON, Math, Date, String, Number, Object, Array, isNaN, parseInt, RegExp, Error
  };

  context.globalThis = context;
  vm.createContext(context);

  for (const file of LOAD_ORDER) {
    const source = fs.readFileSync(path.join(GAS_DIR, file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  // テスト用の台帳 ID。空だと openSpreadsheet_ が例外を投げる。
  vm.runInContext("SPREADSHEET_ID = 'TEST_SHEET_ID';", context);
  return context;
}

/** 台帳と受付可能日の初期状態を作る。 */
function freshSheets(availableDays) {
  const ledgerHeader = null;   // 見出しは setupLedgerSheet で作る
  const ledger = new FakeSheet('予約依頼台帳', []);

  const availRows = (availableDays || []).map(([date, am, pm, memo]) => [
    date, am, pm, '', memo || '', new Date(), 'test@example.jp'
  ]);
  const avail = new FakeSheet('受付可能日', [
    ['日付', '午前', '午後', '対象コース', 'メモ', '最終更新', '更新者'],
    ...availRows
  ]);

  void ledgerHeader;
  return { '予約依頼台帳': ledger, '受付可能日': avail };
}

function dateAfter(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

// ===== テストの枠組み ================================================

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail: condition ? '' : (detail || '') });
}

/** 正常系の入力。個々のテストで一部だけ差し替える。 */
function baseInput(dates) {
  return {
    step: 'send',
    kubun: '健康保険組合の補助を利用',
    extra_kenpo: '○○健康保険組合',
    extra_hojoken: 'あり',
    course: 'スタンダード（1日）',
    options: ['マンモグラフィー'],
    name: '長崎 花子',
    kana: 'ナガサキ ハナコ',
    birth: '1979-05-12',
    sex: '女性',
    tel: '090-0000-0000',
    mail: 'hanako@example.com',
    jikan: '夕方以降',
    rireki: '初めて',
    wishes: JSON.stringify([{ date: dates[0], slot: '午前' }]),
    safety_ninshin: '該当なし',
    safety_kaijo: '不要',
    safety_netsu: '該当なし',
    biko: '',
    elapsed_seconds: '40'
  };
}

function post(context, params) {
  const single = {};
  const multiple = {};
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (Array.isArray(value)) {
      multiple[key] = value;
      single[key] = value[0];
    } else {
      single[key] = value;
    }
  }
  return vm.runInContext('doPost', context)({ parameter: single, parameters: multiple });
}

// ===== 実行 ==========================================================

const day1 = iso(dateAfter(7));
const day2 = iso(dateAfter(9));
const closedDay = iso(dateAfter(8));   // シートに入れない＝受付不可

function newEnv() {
  sentMails.length = 0;
  logs.info.length = 0; logs.warn.length = 0; logs.error.length = 0;
  const sheets = freshSheets([
    [dateAfter(7), '◯', '◯', '予備日'],
    [dateAfter(9), '◯', '', ''],
    [dateAfter(2), '○', '◯', '全角まる（異体字）']   // isOpenMark_ の吸収を確認
  ]);
  const context = buildContext(sheets);
  vm.runInContext('setupLedgerSheet();', context);
  return { context, sheets };
}

function ledgerRows(sheets) { return sheets['予約依頼台帳'].rows; }

// --- 1. 正常系 -------------------------------------------------------
{
  const { context, sheets } = newEnv();
  const out = post(context, baseInput([day1]));
  const rows = ledgerRows(sheets);

  check('正常系：台帳に1行追加される', rows.length === 2, `行数=${rows.length}`);
  check('正常系：受付番号が YYYYMMDD-0001',
    /^\d{8}-0001$/.test(rows[1][0]), `受付番号=${rows[1][0]}`);
  check('正常系：ステータスの初期値が未対応', rows[1][2] === '未対応', rows[1][2]);
  check('正常系：列数が定義と一致',
    rows[1].length === vm.runInContext('LEDGER_COLUMNS.length', context),
    `${rows[1].length} 列`);
  check('正常系：完了画面に受付番号が出る',
    out.getContent().indexOf(rows[1][0]) !== -1);
  check('正常系：メールが2通', sentMails.length === 2, `${sentMails.length}通`);

  const staff = sentMails[0];
  const applicant = sentMails[1];
  check('担当者メールの件名に受付番号とコース',
    staff.subject.indexOf(rows[1][0]) !== -1 && staff.subject.indexOf('スタンダード（1日）') !== -1,
    staff.subject);
  check('担当者メールの Reply-To が申込者', staff.replyTo === 'hanako@example.com', staff.replyTo);
  check('担当者メールに料金が入る', staff.body.indexOf('￥40,700') !== -1);
  check('担当者メールに乳腺・婦人科の曜日注意が入る',
    staff.body.indexOf('水10:00-12:00') !== -1);

  // 機械可読ブロック
  const m = staff.body.match(/#DATA_BEGIN\n(.+)\n#DATA_END/);
  check('機械可読ブロックが1行で出る', !!m);
  if (m) {
    let parsed = null;
    try { parsed = JSON.parse(m[1]); } catch (e) { /* 下でNGになる */ }
    check('機械可読ブロックが JSON として解析できる', !!parsed);
    if (parsed) {
      check('igi キーが廃止されている（2026-09-16 変更）', !('igi' in parsed));
      check('表示されなかった安全確認はキーごと出ない', !('kinzoku' in parsed) && !('zoei' in parsed));
      check('区分別の項目が入る', parsed.kenpo === '○○健康保険組合' && parsed.hojoken === 'あり');
      check('option 配列に選んだ検査が入る',
        Array.isArray(parsed.option) && parsed.option.indexOf('マンモグラフィー') !== -1);
    }
  }

  // 自動返信に載せてはいけないもの（docs/02 §3・CLAUDE.md）
  check('自動返信に生年月日が入らない', applicant.body.indexOf('1979-05-12') === -1);
  check('自動返信に安全確認の回答が入らない',
    applicant.body.indexOf('該当なし') === -1 && applicant.body.indexOf('不要') === -1);
  check('自動返信に保険証・健保組合名が入らない',
    applicant.body.indexOf('○○健康保険組合') === -1);
  check('自動返信の冒頭3行以内に「確定していません」',
    applicant.body.split('\n').slice(0, 6).join('\n').indexOf('確定していません') !== -1);
  check('自動返信に Reply-To を付けない（送信専用）', applicant.replyTo === undefined);
}

// --- 2. 連番 ---------------------------------------------------------
{
  const { context, sheets } = newEnv();
  post(context, baseInput([day1]));
  post(context, baseInput([day1]));
  const rows = ledgerRows(sheets);
  check('連打：2件目の受付番号が -0002',
    /^\d{8}-0002$/.test(rows[2][0]), `2件目=${rows[2] && rows[2][0]}`);
  check('連打：同じ内容でも2行とも残る', rows.length === 3, `行数=${rows.length}`);
}

// --- 3. 入力エラー ---------------------------------------------------
function expectError(label, patch, expectText) {
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), patch);
  const out = post(context, input);
  const body = out.getContent();
  check(label, body.indexOf(expectText) !== -1 && ledgerRows(sheets).length === 1,
    `台帳行数=${ledgerRows(sheets).length}`);
}

expectError('必須未入力：氏名が空だと弾く', { name: '' }, 'お名前をご入力ください');
expectError('電話番号に文字が混ざると弾く', { tel: '090-ABCD' }, '数字とハイフン');
expectError('フリガナがひらがなだと弾く', { kana: 'ながさき はなこ' }, '全角カタカナ');
expectError('メール形式が不正だと弾く', { mail: 'hanako.example.com' }, '形式をご確認');
expectError('希望日が空だと弾く', { wishes: '[]' }, '1つ以上お選びください');
expectError('備考が151文字だと弾く', { biko: 'あ'.repeat(151) }, '150文字以内');
expectError('定義に無いコースは弾く（改ざん対策）', { course: '呼吸器ドック' }, 'コースをお選びください');
expectError('定義に無い追加検査は弾く（改ざん対策）', { options: ['骨密度'] }, 'お選びいただけない項目');

// --- 4. 受付可能日の再検証 -------------------------------------------
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), {
    wishes: JSON.stringify([{ date: closedDay, slot: '午前' }])
  });
  const out = post(context, input);
  check('受付終了の日を選ぶと弾き、選び直しを促す',
    out.getContent().indexOf('受付が終了しました') !== -1 && ledgerRows(sheets).length === 1);
}
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), {
    wishes: JSON.stringify([{ date: day2, slot: '午後' }])   // day2 は午前のみ◯
  });
  post(context, input);
  check('◯の付いていない時間帯も弾く', ledgerRows(sheets).length === 1);
}

// --- 5. 胃の検査まわり（2026-09-16 の一本化）--------------------------
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), { options: ['胃カメラ'] });
  const out = post(context, input);
  check('胃カメラを選んで鎮静剤が未回答だと弾く',
    out.getContent().indexOf('鎮静剤') !== -1 && ledgerRows(sheets).length === 1);
}
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), {
    options: ['胃カメラ'], chinsei: '希望する', safety_kessen: 'わからない'
  });
  post(context, input);
  const rows = ledgerRows(sheets);
  check('胃カメラ＋鎮静剤＋抗血栓薬が揃えば通る', rows.length === 2);
  if (rows.length === 2) {
    const columns = vm.runInContext('LEDGER_COLUMNS', context);
    check('台帳の鎮静剤希望に値が入る',
      rows[1][columns.indexOf('鎮静剤希望')] === '希望する');
    check('台帳の抗血栓薬に値が入る',
      rows[1][columns.indexOf('抗血栓薬')] === 'わからない');
  }
  check('鎮静剤 希望する で自動返信に運転不可の案内が入る',
    sentMails[1].body.indexOf('お帰りいただけません') !== -1);
  check('担当者メールで要確認に★が付く',
    sentMails[0].body.indexOf('★要確認') !== -1);
}
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), {
    options: ['胃カメラ', '胃透視'], chinsei: '希望しない', safety_kessen: '該当なし'
  });
  const out = post(context, input);
  check('胃カメラと胃透視の同時選択を弾く（排他）',
    out.getContent().indexOf('どちらか一方') !== -1 && ledgerRows(sheets).length === 1);
}

// --- 6. 安全確認の表示条件 -------------------------------------------
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), {
    options: ['頭部CT'], safety_zoei: '該当なし'
  });
  post(context, input);
  check('頭部CT のみなら体内金属を聞かずに通る', ledgerRows(sheets).length === 2);
}
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), {
    options: ['頭部CT'], safety_zoei: '該当なし', safety_kinzoku: '該当なし'
  });
  post(context, input);
  const columns = vm.runInContext('LEDGER_COLUMNS', context);
  const rows = ledgerRows(sheets);
  check('頭部CT のみのとき、体内金属を送っても台帳には入れない（未表示は空欄）',
    rows.length === 2 && rows[1][columns.indexOf('体内金属')] === '');
}
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), { options: ['頭部MR'] });
  const out = post(context, input);
  check('頭部MR では体内金属の回答を必須にする',
    out.getContent().indexOf('ペースメーカー') !== -1 && ledgerRows(sheets).length === 1);
}
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), { sex: '男性', safety_ninshin: '' });
  post(context, input);
  check('男性なら妊娠の確認を聞かずに通る', ledgerRows(sheets).length === 2);
}

// --- 7. 迷惑送信対策 -------------------------------------------------
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), { fax_number: '090-1111-2222' });
  post(context, input);
  check('ハニーポットに入力があれば台帳に入れない', ledgerRows(sheets).length === 1);
  check('ハニーポットでもメールは送らない', sentMails.length === 0);
}
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), { elapsed_seconds: '1' });
  post(context, input);
  check('表示から送信までが速すぎると台帳に入れない', ledgerRows(sheets).length === 1);
}

// --- 8. 想定外の文字・極端な値 ---------------------------------------
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), {
    name: '髙橋 🙂 <script>alert(1)</script>',
    biko: '改行を含む\n要望です、カンマ"引用符"も入れます'
  });
  const out = post(context, input);
  const rows = ledgerRows(sheets);
  check('機種依存文字・絵文字・記号が入っても台帳に入る', rows.length === 2);
  check('完了画面にスクリプトタグがそのまま出ない',
    out.getContent().indexOf('<script>alert(1)</script>') === -1);
  if (rows.length === 2) {
    const columns = vm.runInContext('LEDGER_COLUMNS', context);
    check('備考の改行・引用符が壊れずに入る',
      rows[1][columns.indexOf('備考')].indexOf('"引用符"') !== -1);
  }
}
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), { name: 'あ'.repeat(300) });
  post(context, input);
  check('極端に長い氏名でも落ちずに処理できる', ledgerRows(sheets).length === 2);
}
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), {
    wishes: JSON.stringify([
      { date: day1, slot: '午前' }, { date: day1, slot: '午後' },
      { date: day2, slot: '午前' }, { date: iso(dateAfter(2)), slot: '午前' }
    ])
  });
  const out = post(context, input);
  check('希望日が4件だと弾く（最大3件）',
    out.getContent().indexOf('3つまで') !== -1 && ledgerRows(sheets).length === 1);
}
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), { wishes: 'これはJSONではない' });
  const out = post(context, input);
  check('希望日が壊れた形で来ても例外にせず案内する',
    out.getContent().indexOf('選び直して') !== -1 && ledgerRows(sheets).length === 1);
}

// --- 9. 異体字の◯を受け付けるか -------------------------------------
{
  const { context, sheets } = newEnv();
  const input = Object.assign(baseInput([day1]), {
    wishes: JSON.stringify([{ date: iso(dateAfter(2)), slot: '午前' }])   // '○'（異体字）で登録した日
  });
  post(context, input);
  check('受付可能日の◯が異体字（○）でも受け付ける', ledgerRows(sheets).length === 2);
}

// --- 10. 例外時のふるまい --------------------------------------------
{
  sentMails.length = 0;
  const sheets = freshSheets([[dateAfter(7), '◯', '◯', '']]);
  const context = buildContext(sheets);
  vm.runInContext('setupLedgerSheet();', context);
  // 台帳シートを消して、書き込みに失敗する状況を作る
  delete sheets['予約依頼台帳'];
  const out = post(context, baseInput([day1]));
  check('台帳へ書けないときは完了画面を出さない',
    out.getContent().indexOf('受け付けました') === -1);
  check('台帳へ書けないときは電話番号を大きく出す',
    out.getContent().indexOf('095-813-5820') !== -1);
  check('例外はログに残す（握りつぶさない）', logs.error.length > 0);
}

// --- 11. 受付可能日の見張り ------------------------------------------
{
  sentMails.length = 0;
  const sheets = freshSheets([[dateAfter(7), '◯', '◯', '']]);   // 1日分しかない
  const context = buildContext(sheets);
  vm.runInContext('checkAvailability();', context);
  check('選択可能日が7日分を下回ると通知する',
    sentMails.length === 1 && sentMails[0].body.indexOf('下回りました') !== -1);
}
{
  sentMails.length = 0;
  const sheets = freshSheets([]);   // 候補ゼロ
  const context = buildContext(sheets);
  vm.runInContext('checkAvailability();', context);
  check('候補がゼロなら通知する',
    sentMails.length === 1 && sentMails[0].body.indexOf('ゼロ') !== -1);
}
{
  sentMails.length = 0;
  const sheets = freshSheets([[dateAfter(7), '◯', '◯', '']]);
  // 最終更新を4日前にする
  const old = new Date(); old.setDate(old.getDate() - 4);
  sheets['受付可能日'].rows[1][5] = old;
  for (let i = 0; i < 10; i++) sheets['受付可能日'].rows.push([dateAfter(10 + i), '◯', '◯', '', '', old, 'x']);
  const context = buildContext(sheets);
  vm.runInContext('checkAvailability();', context);
  check('3日以上更新がないと通知する',
    sentMails.length === 1 && sentMails[0].body.indexOf('更新されていません') !== -1,
    sentMails[0] ? sentMails[0].body.slice(0, 120) : '通知なし');
}

// --- 12. 保持期間の退避と削除 ----------------------------------------
{
  sentMails.length = 0;
  const sheets = freshSheets([[dateAfter(7), '◯', '◯', '']]);
  const context = buildContext(sheets);
  vm.runInContext('setupLedgerSheet();', context);
  post(context, baseInput([day1]));

  // 1件を400日前の受付にする
  const old = new Date(); old.setDate(old.getDate() - 400);
  sheets['予約依頼台帳'].rows[1][1] = old;
  sentMails.length = 0;
  vm.runInContext('purgeOldApplications();', context);

  check('保持期間を過ぎた行を台帳から削除する',
    sheets['予約依頼台帳'].rows.length === 1, `行数=${sheets['予約依頼台帳'].rows.length}`);
  check('削除したことを情シスへ通知する',
    sentMails.length === 1 && sentMails[0].body.indexOf('退避先') !== -1);
}
{
  const sheets = freshSheets([[dateAfter(7), '◯', '◯', '']]);
  const context = buildContext(sheets);
  vm.runInContext('setupLedgerSheet();', context);
  post(context, baseInput([day1]));
  vm.runInContext('purgeOldApplications();', context);
  check('保持期間内の行は消さない', sheets['予約依頼台帳'].rows.length === 2);
}

// --- 13. 過去日の移動 ------------------------------------------------
{
  const sheets = freshSheets([[dateAfter(7), '◯', '◯', '']]);
  sheets['受付可能日'].rows.push([dateAfter(-3), '◯', '◯', '', '', new Date(), 'x']);
  const context = buildContext(sheets);
  vm.runInContext('archivePastAvailability();', context);
  check('過去日は受付可能日シートから消える',
    sheets['受付可能日'].rows.length === 2, `行数=${sheets['受付可能日'].rows.length}`);
  check('過去日は過去分シートへ移る',
    sheets['過去分'] && sheets['過去分'].rows.length === 1);
}

// ===== 結果 ==========================================================

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   → ' + r.detail : ''));
}
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
