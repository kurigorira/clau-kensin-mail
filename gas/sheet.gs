/**
 * sheet.gs — 台帳への書き込みと、受付可能日の読み込み
 * 2026-09-16 作成。関連：config.gs（シート名・列定義）／form.gs（検証）／main.gs（doPost）
 *
 * 案D では受付メールを解析せず、フォームから台帳へ直接1行追加する。
 * メール解析による起票は行わない（docs/01 §7・F-06 は案B前提のため無効）。
 */

/** スプレッドシートを開く。ID 未設定のまま動かす事故を防ぐ。 */
function openSpreadsheet_() {
  if (!SPREADSHEET_ID) {
    throw new Error('config.gs の SPREADSHEET_ID が未設定です。デプロイ前に台帳のIDを設定してください。');
  }
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/** 名前でシートを取る。無ければ原因が分かる例外にする。 */
function getSheet_(name) {
  var sheet = openSpreadsheet_().getSheetByName(name);
  if (!sheet) {
    throw new Error('シート「' + name + '」が見つかりません。シート名を確認してください。');
  }
  return sheet;
}

/**
 * 台帳の見出し行を用意する。初回セットアップ時に1度だけ手で実行する。
 * 既に見出しがある場合は何もしない（列を作り直すと既存データがずれるため）。
 */
function setupLedgerSheet() {
  var sheet = getSheet_(SHEET_LEDGER);
  if (sheet.getLastRow() > 0) {
    Logger.log('台帳には既に行があります。見出しの作成は行いませんでした。');
    return;
  }
  sheet.getRange(1, 1, 1, LEDGER_COLUMNS.length).setValues([LEDGER_COLUMNS]);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(LEDGER_OPERATION_COLUMN_COUNT);
  Logger.log('台帳の見出しを作成しました（' + LEDGER_COLUMNS.length + '列）。');
}

/**
 * 受付番号を採番する。YYYYMMDD-NNNN 形式で当日連番。
 *
 * 同時送信で番号が重複すると台帳が壊れるため LockService で排他する
 * （gas/README.md の注意事項）。ロックが取れなければ採番せず例外にする。
 * 握りつぶして番号なしで進めると、あとから追跡できない行が残る。
 */
function issueReceiptNumber_(sheet, now) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error('受付番号の採番が混み合っています。時間をおいてお試しください。');
  }
  try {
    var prefix = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd');
    var lastRow = sheet.getLastRow();
    var maxSerial = 0;

    if (lastRow > 1) {
      // A列（受付番号）だけを読む。全列を読むと行数が増えたとき無駄に重くなる。
      var numbers = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < numbers.length; i++) {
        var value = String(numbers[i][0]);
        if (value.indexOf(prefix + '-') !== 0) continue;
        var serial = parseInt(value.slice(prefix.length + 1), 10);
        if (!isNaN(serial) && serial > maxSerial) maxSerial = serial;
      }
    }
    return prefix + '-' + padLeft_(maxSerial + 1, 4);
  } finally {
    lock.releaseLock();   // 例外が出ても必ず解放する
  }
}

/** 数値を左ゼロ埋めする。1 → '0001' */
function padLeft_(number, width) {
  var text = String(number);
  while (text.length < width) text = '0' + text;
  return text;
}

/**
 * 申込を台帳へ1行追加し、採番した受付番号を返す。
 * data は form.gs の検証を通ったもの。ここでは検証しない。
 */
function appendApplication_(data) {
  var sheet = getSheet_(SHEET_LEDGER);
  var now = new Date();
  var receiptNo = issueReceiptNumber_(sheet, now);
  var stamp = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  var wishes = data.wishes || [];
  var row = [
    receiptNo,                 // A 受付番号
    stamp,                     // B 受付日時
    STATUS_INITIAL,            // C ステータス
    '',                        // D 対応担当（受付担当が入れる）
    '',                        // E 確定日時
    '',                        // F 確定コース
    data.name,                 // G 氏名
    data.kana,                 // H フリガナ
    data.birth,                // I 生年月日
    data.sex,                  // J 性別
    data.tel,                  // K 電話番号
    data.mail,                 // L メールアドレス
    data.jikan,                // M 連絡希望時間帯
    data.rireki,               // N 受診歴
    wishAt_(wishes, 0, 'date'), // O 第1希望日
    wishAt_(wishes, 0, 'slot'), // P 第1希望時間帯
    wishAt_(wishes, 1, 'date'), // Q 第2希望日
    wishAt_(wishes, 1, 'slot'), // R 第2希望時間帯
    wishAt_(wishes, 2, 'date'), // S 第3希望日
    wishAt_(wishes, 2, 'slot'), // T 第3希望時間帯
    data.kubun,                // U 受診区分
    data.course,               // V 希望コース
    data.chinsei || '',        // W 鎮静剤希望
    (data.options || []).join('、'),  // X 追加検査
    safetyAt_(data, 'ninshin'),  // Y 妊娠等
    safetyAt_(data, 'kinzoku'),  // Z 体内金属
    safetyAt_(data, 'zoei'),     // AA 造影剤
    safetyAt_(data, 'kessen'),   // AB 抗血栓薬
    safetyAt_(data, 'kaijo'),    // AC 車いす・介助
    safetyAt_(data, 'netsu'),    // AD 2週間以内の発熱
    JSON.stringify(data.extra || {}),  // AE 区分別の追加項目
    data.biko || '',           // AF 備考
    data.cal_generated_at || '', // AG 受付可能日データ生成時刻（障害調査用）
    stamp                      // AH 起票日時
  ];

  if (row.length !== LEDGER_COLUMNS.length) {
    throw new Error('台帳の列数が定義と一致しません（定義 ' + LEDGER_COLUMNS.length +
                    ' / 生成 ' + row.length + '）。config.gs の LEDGER_COLUMNS を確認してください。');
  }

  sheet.appendRow(row);
  return receiptNo;
}

/** 希望日の n 番目を取り出す。未選択の希望は空欄にする（docs/01 付録B）。 */
function wishAt_(wishes, index, key) {
  var wish = wishes[index];
  return wish ? wish[key] : '';
}

/**
 * 安全確認の回答を取り出す。
 * 表示されなかった項目は空欄にする。「未表示」と「未入力」を区別するため、
 * form.gs の側でキー自体を持たせない（docs/02 §2）。
 */
function safetyAt_(data, key) {
  var answers = data.safety || {};
  return Object.prototype.hasOwnProperty.call(answers, key) ? answers[key] : '';
}

/**
 * 受付可能日シートを読み、選べる日を返す。
 * 返す形は docs/03 §3 の JSON と同じ： { generated_at, days: { 'YYYY-MM-DD': ['午前','午後'] } }
 *
 * ◯が付いていない日はキーごと出力しない。空欄・×・その他はすべて「不可」とみなす。
 */
function readAvailability_() {
  var sheet = getSheet_(SHEET_AVAIL);
  var result = {
    generated_at: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
    days: {}
  };

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return result;   // 見出しだけ＝候補ゼロ

  // A:日付 B:午前 C:午後 の3列だけ読む（D 対象コース・E メモは画面に出さない）
  var rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  var today = startOfDay_(new Date());

  for (var i = 0; i < rows.length; i++) {
    var date = rows[i][0];
    if (!(date instanceof Date)) continue;          // 空行や書式違いは無視する
    if (startOfDay_(date) < today) continue;        // 過去日は出さない

    var slots = [];
    if (isOpenMark_(rows[i][1])) slots.push('午前');
    if (isOpenMark_(rows[i][2])) slots.push('午後');
    if (!slots.length) continue;

    result.days[Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd')] = slots;
  }
  return result;
}

/**
 * 受付可能を表す印かどうか。
 * 運用では全角の「◯」を使うが、似た文字（○ ◎ ●）や O/o を打つ人が必ず出る。
 * ここで吸収しないと「入れたのに反映されない」という問い合わせになる。
 */
function isOpenMark_(value) {
  var text = String(value == null ? '' : value).trim();
  if (!text) return false;
  return ['◯', '○', '〇', '◎', '●', 'O', 'o', '0', '可'].indexOf(text) !== -1;
}

/** 時刻を落として日付だけにする。日付の前後比較に使う。 */
function startOfDay_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
