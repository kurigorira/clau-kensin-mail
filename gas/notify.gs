/**
 * notify.gs — 定期実行（受付可能日の見張りと、保持期間の管理）
 * 2026-09-16 作成。関連：config.gs（閾値）／sheet.gs（シート取得）／docs/03 §5
 *
 * ここに入っている処理は、どれも「止まっても誰も気づかない」種類のもの。
 * だから人の運用ではなくトリガーで回す。
 */

/**
 * トリガーをまとめて作る。初回セットアップ時に1度だけ手で実行する。
 * 二重登録を避けるため、同名のトリガーがあれば先に消す。
 */
function setupTriggers() {
  var handlers = ['checkAvailability', 'archivePastAvailability', 'purgeOldApplications'];
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (handlers.indexOf(existing[i].getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  // 受付開始前に見張る。枯渇していれば当日の朝に気づける。
  ScriptApp.newTrigger('checkAvailability').timeBased().atHour(8).everyDays(1).create();
  // 過去日の行を毎朝「過去分」へ移す（docs/03 §2。手で消す必要をなくす）
  ScriptApp.newTrigger('archivePastAvailability').timeBased().atHour(5).everyDays(1).create();
  // 保持期間の超過分を毎月1日に退避・削除する
  ScriptApp.newTrigger('purgeOldApplications').timeBased().onMonthDay(1).atHour(3).create();

  Logger.log('トリガーを作成しました：' + handlers.join(' / '));
}

/**
 * 受付可能日シートが編集されたら、最終更新と更新者を記録する。
 * 「3日以上更新がない」の判定に使うため。
 *
 * ※ これは「インストール可能なトリガー」として登録する必要がある。
 *    単純トリガーの onEdit では実行ユーザーのメールアドレスを取得できない。
 */
function onEditAvailability(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_AVAIL) return;
  if (e.range.getRow() < 2) return;              // 見出し行は無視
  if (e.range.getColumn() > 5) return;           // F・G は自分が書く列なので反応しない

  var row = e.range.getRow();
  var editor = '';
  try {
    editor = Session.getActiveUser().getEmail() || '';
  } catch (error) {
    // 権限の都合で取れないことがある。取れなくても時刻だけは残す。
    console.warn('更新者の取得に失敗: ' + error.message);
  }
  sheet.getRange(row, 6).setValue(nowStamp_());  // F 最終更新
  sheet.getRange(row, 7).setValue(editor);       // G 更新者
}

/**
 * 受付可能日が枯渇していないか、更新が止まっていないかを見る（docs/03 §5-4, 5-5）。
 *
 * このカレンダーは更新が止まった瞬間にフォーム全体が使えなくなる。
 * 気づく仕組みが無いと、申し込みがゼロになった理由が誰にも分からない。
 */
function checkAvailability() {
  var problems = [];

  try {
    var availability = readAvailability_();
    var openDays = Object.keys(availability.days).length;

    if (openDays === 0) {
      problems.push('選択可能日がゼロです。フォームはカレンダーを隠し、電話案内に切り替わっています。');
    } else if (openDays < AVAIL_MIN_DAYS) {
      problems.push('選択可能日が' + openDays + '日分しかありません（' +
                    AVAIL_MIN_DAYS + '日分を下回りました）。');
    }

    var staleDays = daysSinceLastUpdate_();
    if (staleDays === null) {
      problems.push('最終更新の記録がありません。F列（最終更新）が書かれているか確認してください。');
    } else if (staleDays >= AVAIL_STALE_DAYS) {
      problems.push('受付可能日シートが' + staleDays + '日間更新されていません。');
    }
  } catch (error) {
    // 見張り役自身が落ちたことも知らせる。黙って止まるのが一番困る。
    problems.push('受付可能日の点検中にエラーが発生しました：' + error.message);
  }

  if (!problems.length) return;

  var body = [
    '健診の予約依頼フォームから自動送信しています。',
    '',
    '受付可能日シートについて、次の点をご確認ください。',
    ''
  ].concat(problems.map(function (text) { return '・' + text; })).concat([
    '',
    '対応：受付可能日シートを開き、翌日以降の◯を入れてください。',
    '目安は2週間先まで、最低10日分です。',
    '',
    '※ 候補がゼロの間、申込者にはカレンダーではなく電話案内が表示されます。'
  ]).join('\n');

  MailApp.sendEmail({
    to: MAIL_TO_STAFF + ',' + MAIL_TO_SYSADMIN,
    subject: '【要対応】健診予約フォーム 受付可能日のお知らせ',
    body: body,
    name: MAIL_FROM_NAME
  });
}

/**
 * 受付可能日シートの最終更新から何日経ったかを返す。
 * 1件も記録が無ければ null。
 */
function daysSinceLastUpdate_() {
  var sheet = getSheet_(SHEET_AVAIL);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var stamps = sheet.getRange(2, 6, lastRow - 1, 1).getValues();   // F列
  var latest = null;
  for (var i = 0; i < stamps.length; i++) {
    var value = stamps[i][0];
    var date = (value instanceof Date) ? value : (value ? new Date(value) : null);
    if (!date || isNaN(date.getTime())) continue;
    if (!latest || date > latest) latest = date;
  }
  if (!latest) return null;
  return Math.floor((new Date().getTime() - latest.getTime()) / 86400000);
}

/**
 * 過去日の行を「過去分」シートへ移す（docs/03 §2）。
 * 手で消す必要をなくすのが目的。消さずに移すのは、あとから確認できるようにするため。
 */
function archivePastAvailability() {
  var source = getSheet_(SHEET_AVAIL);
  var lastRow = source.getLastRow();
  if (lastRow < 2) return;

  var width = Math.max(source.getLastColumn(), 7);
  var rows = source.getRange(2, 1, lastRow - 1, width).getValues();
  var today = startOfDay_(new Date());

  var moved = [];
  var keptRowNumbers = [];
  for (var i = 0; i < rows.length; i++) {
    var date = rows[i][0];
    if (date instanceof Date && startOfDay_(date) < today) {
      moved.push(rows[i]);
      keptRowNumbers.push(i + 2);   // 実際の行番号
    }
  }
  if (!moved.length) return;

  var archive = openSpreadsheet_().getSheetByName(SHEET_ARCHIVE);
  if (!archive) archive = openSpreadsheet_().insertSheet(SHEET_ARCHIVE);
  archive.getRange(archive.getLastRow() + 1, 1, moved.length, width).setValues(moved);

  // 下の行から消す。上から消すと行番号がずれる。
  for (var j = keptRowNumbers.length - 1; j >= 0; j--) {
    source.deleteRow(keptRowNumbers[j]);
  }
  Logger.log('受付可能日の過去分を' + moved.length + '行、過去分シートへ移しました。');
}

/**
 * 保持期間を過ぎた申込を、CSVへ退避してから台帳から削除する。
 *
 * 2026-09-16 のクラウド利用承認の条件で、保持期間は1年が「上限」。
 * 目安ではないため、放置すると承認条件違反になる。
 * docs/01 の「月1回CSVエクスポート」はバックアップの話であって削除の話ではない。
 * 退避と削除は別物なので、ここで両方を行う。
 */
function purgeOldApplications() {
  var sheet = getSheet_(SHEET_LEDGER);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var width = sheet.getLastColumn();
  var rows = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  var limit = new Date();
  limit.setDate(limit.getDate() - RETENTION_DAYS);

  var expired = [];
  var expiredRowNumbers = [];
  for (var i = 0; i < rows.length; i++) {
    var received = rows[i][1];    // B 受付日時
    var date = (received instanceof Date) ? received : (received ? new Date(received) : null);
    if (!date || isNaN(date.getTime())) continue;
    if (date >= limit) continue;
    expired.push(rows[i]);
    expiredRowNumbers.push(i + 2);
  }
  if (!expired.length) return;

  // 先に退避する。退避に失敗したら削除しない（消してから気づくのが最悪）。
  var fileName = '健診予約依頼_退避_' +
    Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd') + '.csv';
  var csv = toCsv_([LEDGER_COLUMNS].concat(expired));
  var file = DriveApp.createFile(fileName, csv, MimeType.CSV);

  for (var j = expiredRowNumbers.length - 1; j >= 0; j--) {
    sheet.deleteRow(expiredRowNumbers[j]);
  }

  MailApp.sendEmail({
    to: MAIL_TO_SYSADMIN,
    subject: '【健診予約フォーム】保持期間を過ぎた申込を退避・削除しました',
    body: [
      '保持期間（' + RETENTION_DAYS + '日）を過ぎた申込を、台帳から削除しました。',
      '',
      '　削除件数：' + expired.length + '件',
      '　退避先　：' + fileName,
      '　ファイル：' + file.getUrl(),
      '',
      'この処理は 2026-09-16 のクラウド利用承認の条件（保持期間1年が上限）に基づくものです。',
      '退避ファイルの保管場所と期間は、院内の規程に従って管理してください。'
    ].join('\n'),
    name: MAIL_FROM_NAME
  });

  Logger.log('保持期間超過の' + expired.length + '行を退避・削除しました。');
}

/**
 * 二次元配列を CSV 文字列にする。
 * ダブルクォート・カンマ・改行を含む値を壊さないよう、必ず引用符で囲む。
 */
function toCsv_(rows) {
  return rows.map(function (row) {
    return row.map(function (cell) {
      var text = (cell instanceof Date)
        ? Utilities.formatDate(cell, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
        : String(cell == null ? '' : cell);
      return '"' + text.replace(/"/g, '""') + '"';
    }).join(',');
  }).join('\r\n');
}
