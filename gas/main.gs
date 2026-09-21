/**
 * main.gs — Web アプリのエントリ（画面配信と送信受付）
 * 2026-09-16 作成。関連：form.gs（検証）／sheet.gs（台帳）／mail.gs（メール）
 *
 * 画面は HtmlService で配信し、送信は普通の form POST で受ける。
 * google.script.run を使わないのは、JavaScript が無効な環境でも入力・送信できる
 * ようにするため（docs/01 F-01 の受け入れ条件）。
 */

/** 画面を配信する。 */
function doGet() {
  if (IS_SUSPENDED) {
    return renderSuspended_();
  }

  var template = HtmlService.createTemplateFromFile('index');
  template.model = buildViewModel_();
  return template.evaluate()
    .setTitle('健診・人間ドック 予約依頼フォーム｜' + CENTER.name)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 画面が必要とする値をまとめる。
 * 選択肢は config.gs だけを見ればよい状態にしておく（改定時の変更箇所を1か所に限定）。
 */
function buildViewModel_() {
  var availability = readAvailabilitySafely_();
  return {
    center: CENTER,
    kubunList: KUBUN_LIST,
    courseList: COURSE_LIST,
    optionList: OPTION_LIST,
    safetyList: SAFETY_LIST,
    sexList: SEX_LIST,
    jikanList: JIKAN_LIST,
    rirekiList: RIREKI_LIST,
    chinseiList: CHINSEI_LIST,
    slotList: SLOT_LIST,
    wishMax: WISH_MAX,
    priceAsOf: PRICE_AS_OF,
    callbackDays: CALLBACK_BUSINESS_DAYS,
    honeypotField: HONEYPOT_FIELD,
    availability: availability,
    hasAvailability: Object.keys(availability.days).length > 0,
    execUrl: ScriptApp.getService().getUrl()
  };
}

/**
 * 受付可能日を読む。取得に失敗しても画面自体は出す。
 *
 * 失敗や候補ゼロのときは、空のカレンダーを出さずに電話案内へ切り替える
 * （docs/03 §4-2）。押せる日が無い画面を見て申込者が諦めるのが最悪の結果になる。
 */
function readAvailabilitySafely_() {
  try {
    return readAvailability_();
  } catch (error) {
    console.error('受付可能日の取得に失敗: ' + error.message);
    return { generated_at: '', days: {} };
  }
}

/**
 * 送信を受ける。
 *
 * step=confirm … 確認画面を返す（JavaScript が無効な環境用の往復）
 * step=send    … 検証して台帳へ入れ、メールを送り、完了画面を返す
 *
 * JavaScript が有効な場合、確認画面は画面側で描くので step=send が直接来る。
 */
function doPost(e) {
  try {
    var raw = readParameters_(e);

    if (trimmed_(raw.step) === 'confirm') {
      return renderConfirm_(raw);
    }

    var availability = readAvailability_();
    var result = validateApplication_(raw, availability);

    if (!result.ok) {
      // bot と判定したものは、理由を伝えずそのまま完了画面と同じ見た目を返す。
      // 「なぜ弾かれたか」を教えると回避されるため。
      if (result.code === 'bot') {
        console.warn('迷惑送信とみなして破棄しました。');
        return renderDone_('—');
      }
      return renderError_(result.errors, result.code === 'slot_taken');
    }

    var receiptNo = appendApplication_(result.data);

    // メールの失敗で申込自体を無かったことにはしない。
    // 台帳には既に入っているので、受付担当が一覧で気づける（docs/01 リスク欄）。
    try {
      sendStaffMail_(receiptNo, result.data);
      sendApplicantMail_(receiptNo, result.data);
    } catch (mailError) {
      console.error('受付番号 ' + receiptNo + ' のメール送信に失敗: ' + mailError.message);
    }

    return renderDone_(receiptNo);

  } catch (error) {
    // doPost は必ず try/catch する。失敗時は完了画面を出さず、電話番号を大きく出す
    // （gas/README.md の注意事項）。受け付けていないのに受け付けた顔をしない。
    console.error('送信処理で例外: ' + error.message + '\n' + (error.stack || ''));
    return renderFailure_();
  }
}

/**
 * POST されたパラメータを1つのオブジェクトにまとめる。
 * 追加検査のように複数選べる項目は配列で受ける必要があるため、
 * e.parameters（複数値）と e.parameter（単一値）を使い分ける。
 */
function readParameters_(e) {
  var raw = {};
  if (!e) return raw;

  var single = e.parameter || {};
  for (var key in single) {
    if (Object.prototype.hasOwnProperty.call(single, key)) raw[key] = single[key];
  }

  var multiple = e.parameters || {};
  if (multiple.options) raw.options = multiple.options;

  return raw;
}

// ===== 画面の組み立て ===============================================
// 画面はどれも1枚もので、外部ファイルを読まない。

function htmlPage_(bodyHtml) {
  var html =
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>健診・人間ドック 予約依頼｜' + escapeHtml_(CENTER.name) + '</title>' +
    '<style>' +
    'body{font-family:system-ui,"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;' +
    'font-size:16px;line-height:1.9;color:#1a1a1a;background:#fff;margin:0;padding:24px 16px;}' +
    '.wrap{max-width:640px;margin:0 auto;}' +
    'h1{font-size:22px;margin:0 0 16px;}' +
    '.box{border:2px solid #0f6e63;padding:16px;margin:16px 0;}' +
    '.box.err{border-color:#b3261e;}' +
    '.tel{font-size:26px;font-weight:700;letter-spacing:.02em;}' +
    'ul{padding-left:1.3em;}' +
    '.no{font-size:22px;font-weight:700;font-family:ui-monospace,monospace;}' +
    'a{color:#0a4c44;}' +
    '</style></head><body><div class="wrap">' + bodyHtml + '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 受付停止中の画面（docs/01 F-11）。 */
function renderSuspended_() {
  return htmlPage_(
    '<h1>予約依頼の受付について</h1>' +
    '<div class="box err"><p>' + escapeHtml_(SUSPENDED_MESSAGE) + '</p>' +
    '<p class="tel">' + escapeHtml_(CENTER.tel) + '</p>' +
    '<p>' + escapeHtml_(CENTER.name) + '　受付 ' + escapeHtml_(CENTER.hours) + '</p></div>'
  );
}

/** 完了画面。受付番号を控えられるように大きく出す。 */
function renderDone_(receiptNo) {
  return htmlPage_(
    '<h1>予約のご依頼を受け付けました</h1>' +
    '<div class="box">' +
    '<p>受付番号</p><p class="no">' + escapeHtml_(receiptNo) + '</p>' +
    '<p><strong>この時点では受診日は確定していません。</strong>' +
    CALLBACK_BUSINESS_DAYS + '営業日以内（日曜・祝日を除く）に、担当者からお電話いたします。</p>' +
    '</div>' +
    '<p>確認のメールをお送りしました。届かない場合は、迷惑メールフォルダをご確認のうえ、' +
    'お手数ですが下記までお電話ください。</p>' +
    '<p class="tel">' + escapeHtml_(CENTER.tel) + '</p>' +
    '<p>' + escapeHtml_(CENTER.name) + '　受付 ' + escapeHtml_(CENTER.hours) + '</p>'
  );
}

/** 入力エラー画面。何を直せばよいかだけを伝える。 */
function renderError_(errors, isSlotTaken) {
  var items = (errors || []).map(function (message) {
    return '<li>' + escapeHtml_(message) + '</li>';
  }).join('');

  return htmlPage_(
    '<h1>' + (isSlotTaken ? 'ご希望の日が受付終了になりました' : '入力内容をご確認ください') + '</h1>' +
    '<div class="box err"><ul>' + items + '</ul></div>' +
    '<p><a href="javascript:history.back()">前の画面に戻って修正する</a></p>' +
    '<p>お電話でも承ります。</p><p class="tel">' + escapeHtml_(CENTER.tel) + '</p>'
  );
}

/** 送信処理そのものが失敗したときの画面。受け付けた顔をしない。 */
function renderFailure_() {
  return htmlPage_(
    '<h1>送信できませんでした</h1>' +
    '<div class="box err">' +
    '<p><strong>お申し込みは受け付けられていません。</strong>' +
    'お手数ですが、お電話でお申し込みください。</p>' +
    '<p class="tel">' + escapeHtml_(CENTER.tel) + '</p>' +
    '<p>' + escapeHtml_(CENTER.name) + '　受付 ' + escapeHtml_(CENTER.hours) + '</p>' +
    '</div>'
  );
}

/**
 * 確認画面（JavaScript 無効時のみ通る）。
 * 入力値をそのまま hidden で持ち回し、step=send で送り直す。
 */
function renderConfirm_(raw) {
  var rows = [];
  var hidden = [];

  function addRow(label, value) {
    if (value === '' || value == null) return;
    rows.push('<tr><th style="text-align:left;padding:4px 12px 4px 0;vertical-align:top;">' +
      escapeHtml_(label) + '</th><td style="padding:4px 0;">' + escapeHtml_(value) + '</td></tr>');
  }
  function addHidden(name, value) {
    hidden.push('<input type="hidden" name="' + escapeHtml_(name) + '" value="' + escapeHtml_(value) + '">');
  }

  for (var key in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    if (key === 'step') continue;
    var value = raw[key];
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) addHidden(key, value[i]);
      addRow(key, value.join('、'));
    } else {
      addHidden(key, value);
      addRow(key, value);
    }
  }
  addHidden('step', 'send');

  return htmlPage_(
    '<h1>入力内容のご確認</h1>' +
    '<p>この内容でよろしければ「送信する」を押してください。' +
    '<strong>送信しても受診日は確定しません。</strong>担当者から折り返しお電話します。</p>' +
    '<table>' + rows.join('') + '</table>' +
    '<form method="post" action="' + escapeHtml_(ScriptApp.getService().getUrl()) + '">' +
    hidden.join('') +
    '<p><button type="submit" style="font-size:18px;padding:12px 28px;">送信する</button></p>' +
    '</form>' +
    '<p><a href="javascript:history.back()">前の画面に戻って修正する</a></p>'
  );
}

/** HTML に値を差し込む前のエスケープ。入力値をそのまま画面に出さない。 */
function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
